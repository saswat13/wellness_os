"""Confidential Cognito code/PKCE exchange and pinned-issuer RS256 verification."""

import hmac
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
import jwt

from ..core import Principal, Problem, utcnow
from ..sessions import TokenBundle


@dataclass(frozen=True)
class CognitoConfig:
    issuer: str
    domain: str
    client_id: str
    client_secret: str = field(repr=False)
    redirect_uri: str
    scopes: tuple[str, ...] = ("openid", "email", "form/read", "form/write")

    def __post_init__(self):
        if not re.fullmatch(
            r"https://cognito-idp\.us-east-1\.amazonaws\.com/us-east-1_[A-Za-z0-9]+", self.issuer
        ):
            raise ValueError("Pinned us-east-1 Cognito issuer required")
        if not re.fullmatch(
            r"https://[a-z0-9-]+\.auth\.us-east-1\.amazoncognito\.com", self.domain
        ):
            raise ValueError("Pinned Cognito managed-login origin required")
        if not self.redirect_uri.startswith("https://") or not self.client_id:
            raise ValueError("Complete HTTPS confidential-client configuration required")


class Cognito:
    def __init__(self, config, http=None, clock=utcnow):
        self.config, self.http, self.clock = (
            config,
            http or httpx.Client(timeout=8, follow_redirects=False),
            clock,
        )
        self.keys, self.keys_expiry = {}, 0
        self.unknown_refresh = 0.0

    def authorize_url(self, state, nonce, challenge):
        return (
            self.config.domain
            + "/oauth2/authorize?"
            + urlencode(
                {
                    "response_type": "code",
                    "client_id": self.config.client_id,
                    "redirect_uri": self.config.redirect_uri,
                    "scope": " ".join(self.config.scopes),
                    "state": state,
                    "nonce": nonce,
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "prompt": "login",
                }
            )
        )

    def verify(self, token, token_use, nonce=None):
        try:
            if not isinstance(token, str) or len(token) > 16000:
                raise ValueError()
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
                raise ValueError()
            now = self.clock().timestamp()
            if now >= self.keys_expiry:
                response = self.http.get(self.config.issuer + "/.well-known/jwks.json")
                response.raise_for_status()
                data = response.json()
                self.keys = {
                    k["kid"]: jwt.PyJWK.from_dict(k).key
                    for k in data["keys"]
                    if k.get("kty") == "RSA" and k.get("use", "sig") == "sig"
                }
                self.keys_expiry = now + 300
            key = self.keys.get(header["kid"])
            if key is None:
                # Permit a bounded key refresh after rotation; no token-supplied URLs.
                if not getattr(self, "unknown_refresh", 0) or now - self.unknown_refresh > 60:
                    self.unknown_refresh = now
                    self.keys_expiry = 0
                    return self.verify(token, token_use, nonce)
                raise ValueError()
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=self.config.issuer,
                audience=self.config.client_id if token_use == "id" else None,
                options={
                    "verify_aud": token_use == "id",
                    "verify_exp": False,
                    "verify_iat": False,
                    "verify_nbf": False,
                    "require": ["exp", "iat", "sub", "iss", "token_use"],
                },
            )
            if (
                claims["token_use"] != token_use
                or not isinstance(claims["sub"], str)
                or not claims["sub"]
            ):
                raise ValueError()
            if claims["exp"] <= now or claims["iat"] > now + 30 or claims.get("nbf", 0) > now + 30:
                raise ValueError()
            if token_use == "access":
                if claims.get("client_id") != self.config.client_id:
                    raise ValueError()
                if not {"form/read", "form/write"}.issubset(claims.get("scope", "").split()):
                    raise ValueError()
            if nonce is not None and (
                not isinstance(claims.get("nonce"), str)
                or not hmac.compare_digest(claims["nonce"], nonce)
            ):
                raise ValueError()
            return claims
        except (httpx.HTTPError, KeyError, TypeError, ValueError, jwt.PyJWTError):
            raise Problem(401, "INVALID_TOKEN") from None

    def _request(self, path, data):
        if not self.config.client_secret:
            raise Problem(503, "CLIENT_SECRET_UNAVAILABLE")
        try:
            response = self.http.post(
                self.config.domain + path,
                data=data,
                auth=(self.config.client_id, self.config.client_secret),
            )
            if response.status_code in (400, 401):
                raise Problem(401, "SESSION_REVOKED")
            response.raise_for_status()
            return response.json() if response.content else {}
        except (httpx.HTTPError, ValueError):
            raise Problem(503, "IDENTITY_PROVIDER_UNAVAILABLE") from None

    def _bundle(self, raw, old_refresh=None, nonce=None):
        access = self.verify(raw.get("access_token"), "access")
        if nonce is not None:
            identity = self.verify(raw.get("id_token"), "id", nonce)
            if identity["sub"] != access["sub"] or identity.get("email_verified") is not True:
                raise Problem(403, "VERIFIED_INVITATION_REQUIRED")
        refresh = raw.get("refresh_token") or old_refresh
        if not isinstance(refresh, str) or not refresh:
            raise Problem(401, "INVALID_TOKEN")
        return TokenBundle(
            Principal(access["sub"], frozenset(access["scope"].split())),
            raw["access_token"],
            refresh,
            datetime.fromtimestamp(access["exp"], timezone.utc),
        )

    def exchange(self, code, verifier, nonce):
        raw = self._request(
            "/oauth2/token",
            {
                "grant_type": "authorization_code",
                "client_id": self.config.client_id,
                "redirect_uri": self.config.redirect_uri,
                "code": code,
                "code_verifier": verifier,
            },
        )
        return self._bundle(raw, nonce=nonce)

    def renew(self, refresh_token):
        raw = self._request(
            "/oauth2/token",
            {
                "grant_type": "refresh_token",
                "client_id": self.config.client_id,
                "refresh_token": refresh_token,
            },
        )
        return self._bundle(raw, old_refresh=refresh_token)

    def revoke(self, refresh_token):
        self._request(
            "/oauth2/revoke", {"token": refresh_token, "client_id": self.config.client_id}
        )
