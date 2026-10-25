"""Local-only fake issuer and memory session coordinator; excluded from Lambda assets."""

import hmac
import secrets
from copy import deepcopy
from datetime import datetime, timedelta
from hashlib import sha256
from threading import RLock

from .core import Principal, Problem, utcnow
from .sessions import (
    IdentityProvider,
    ServerSession,
    SessionConfig,
    SessionRepository,
    TokenBundle,
    challenge,
)


class MemorySessions:
    def __init__(self):
        self.lock = RLock()
        self._rows = {}

    def get(self, cookie_hash):
        return deepcopy(self._rows.get(cookie_hash))

    def put(self, cookie_hash, session):
        self._rows[cookie_hash] = deepcopy(session)

    def revoke(self, cookie_hash):
        self._rows.pop(cookie_hash, None)


class FakeIdentityProvider:
    """Explicitly instantiated test fake; no HTTP/header-selected fake-auth mode."""

    def __init__(self, invited, clock=utcnow):
        self.invited, self.clock = frozenset(invited), clock
        self.codes, self.refreshes = {}, {}
        self.renewals = 0
        self.unavailable = False

    def issue_code(self, subject, code_challenge, nonce):
        if subject not in self.invited:
            raise Problem(403, "INVITATION_REQUIRED")
        code = secrets.token_urlsafe(32)
        self.codes[code] = (subject, code_challenge, nonce)
        return code

    def _tokens(self, subject):
        refresh = secrets.token_urlsafe(32)
        self.refreshes[refresh] = subject
        return TokenBundle(
            Principal(subject),
            secrets.token_urlsafe(32),
            refresh,
            self.clock() + timedelta(minutes=10),
        )

    def exchange(self, code, verifier, nonce):
        info = self.codes.pop(code, None)
        if not info or info[1] != challenge(verifier) or info[2] != nonce:
            raise Problem(401, "INVALID_LOGIN")
        return self._tokens(info[0])

    def renew(self, refresh_token):
        if self.unavailable:
            raise Problem(503, "IDENTITY_PROVIDER_UNAVAILABLE")
        subject = self.refreshes.pop(refresh_token, None)
        if subject is None:
            raise Problem(401, "SESSION_REVOKED")
        self.renewals += 1
        return self._tokens(subject)

    def revoke(self, refresh_token):
        self.refreshes.pop(refresh_token, None)


class Sessions:
    def __init__(
        self, provider: IdentityProvider, repository: SessionRepository, config=None, clock=utcnow
    ):
        self.provider, self.repository, self.config, self.clock = (
            provider,
            repository,
            config or SessionConfig(),
            clock,
        )
        self._logins: dict[str, tuple[str, str, str, datetime]] = {}
        self._login_lock = RLock()

    def begin(self):
        state, verifier, nonce, binding = (secrets.token_urlsafe(32) for _ in range(4))
        with self._login_lock:
            self._logins[sha256(state.encode()).hexdigest()] = (
                verifier,
                nonce,
                sha256(binding.encode()).hexdigest(),
                self.clock() + timedelta(minutes=10),
            )
        return {
            "state": state,
            "nonce": nonce,
            "codeChallenge": challenge(verifier),
            "codeChallengeMethod": "S256",
            "bindingCookie": binding,
        }

    def callback(self, state, code, binding_cookie):
        with self._login_lock:
            key = sha256(state.encode()).hexdigest()
            info = self._logins.get(key)
            if (
                not info
                or info[3] <= self.clock()
                or not hmac.compare_digest(info[2], sha256(binding_cookie.encode()).hexdigest())
            ):
                raise Problem(401, "INVALID_LOGIN")
            del self._logins[key]
        tokens = self.provider.exchange(code, info[0], info[1])
        tokens.principal.require("form/read")
        cookie = secrets.token_urlsafe(32)
        maximum = self.clock() + self.config.max_lifetime
        record = ServerSession(
            tokens,
            secrets.token_urlsafe(32),
            maximum,
            min(maximum, self.clock() + self.config.idle_lifetime),
        )
        with self.repository.lock:
            self.repository.put(sha256(cookie.encode()).hexdigest(), record)
        max_age = int(min(self.config.max_lifetime, self.config.idle_lifetime).total_seconds())
        return {
            "cookie": cookie,
            "setCookie": f"__Host-form_session={cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}",
        }

    def authenticate(self, cookie):
        key = sha256(cookie.encode()).hexdigest()
        # Process-local serialization for the fake. Distributed CAS/lease is a deployment gate.
        with self.repository.lock:
            record = self.repository.get(key)
            if not record or min(record.absolute_expiry, record.idle_expiry) <= self.clock():
                self.repository.revoke(key)
                raise Problem(401, "SESSION_EXPIRED")
            if record.tokens.access_expires <= self.clock():
                renewed = self.provider.renew(record.tokens.refresh_token)
                if renewed.principal != record.tokens.principal:
                    self.repository.revoke(key)
                    raise Problem(401, "IDENTITY_CHANGED")
                record.tokens = renewed
            record.idle_expiry = min(
                record.absolute_expiry, self.clock() + self.config.idle_lifetime
            )
            self.repository.put(key, record)
            return record.tokens.principal

    def session_info(self, cookie):
        principal = self.authenticate(cookie)
        with self.repository.lock:
            record = self.repository.get(sha256(cookie.encode()).hexdigest())
            if not record:
                raise Problem(401, "SESSION_REVOKED")
            return {
                "subject": principal.subject,
                "csrfToken": record.csrf,
                "expiresAt": record.absolute_expiry,
            }

    def authorize_mutation(self, cookie, origin, csrf):
        principal = self.authenticate(cookie)
        with self.repository.lock:
            record = self.repository.get(sha256(cookie.encode()).hexdigest())
            if (
                origin != self.config.origin
                or not record
                or not hmac.compare_digest(record.csrf, csrf)
            ):
                raise Problem(403, "CSRF_FAILED")
        principal.require("form/write")
        return principal

    def logout(self, cookie, origin, csrf):
        self.authorize_mutation(cookie, origin, csrf)
        with self.repository.lock:
            key = sha256(cookie.encode()).hexdigest()
            record = self.repository.get(key)
            self.repository.revoke(key)
            if record:
                self.provider.revoke(record.tokens.refresh_token)
        return "__Host-form_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
