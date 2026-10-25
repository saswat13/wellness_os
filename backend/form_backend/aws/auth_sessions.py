"""DynamoDB BFF sessions with one-use login state and fenced refresh leases.

Tokens are confined to the BFF Accounts namespace (SSE encrypted table). A crashed
refresh is recovered after a short lease, within Cognito's rotation grace period.
"""

import hmac
import logging
import secrets
import time
from datetime import timedelta
from hashlib import sha256

from ..core import Principal, Problem, json_text, load_json, utcnow
from ..sessions import SessionConfig, TokenBundle, challenge
from .dynamo import attributes, stamp

logger = logging.getLogger(__name__)


def hashed(value):
    return sha256(value.encode()).hexdigest()


class DurableSessions:
    def __init__(self, store, provider, config=None, clock=utcnow, sleep=time.sleep):
        self.store, self.provider = store, provider
        self.config, self.clock, self.sleep = config or SessionConfig(), clock, sleep
        if self.config.max_lifetime > timedelta(days=7):
            raise ValueError("Session maximum cannot exceed seven days")
        self.table = store.tables.accounts

    def _get(self, namespace, key):
        return self.store.get(self.table, namespace + "#" + key, "META")

    def _put(self, row, expected=0):
        args = {
            "TableName": self.table,
            "Item": attributes(row),
            "ConditionExpression": "attribute_not_exists(PK)" if expected == 0 else "revision = :r",
        }
        if expected:
            args["ExpressionAttributeValues"] = attributes({":r": expected})
        self.store.call("put_item", **args)

    def begin(self):
        state, verifier, nonce, binding = (secrets.token_urlsafe(32) for _ in range(4))
        expires = int(self.clock().timestamp()) + 600
        self._put(
            {
                "PK": "LOGIN#" + hashed(state),
                "SK": "META",
                "revision": 1,
                "verifier": verifier,
                "nonce": nonce,
                "binding": hashed(binding),
                "expires": expires,
            }
        )
        return {
            "state": state,
            "nonce": nonce,
            "codeChallenge": challenge(verifier),
            "bindingCookie": binding,
        }

    def callback(self, state, code, binding_cookie, old_cookie=None):
        row = self._get("LOGIN", hashed(state))
        if not row:
            logger.warning("auth_callback_rejected branch=state_not_found")
            raise Problem(401, "INVALID_LOGIN")
        if int(row["expires"]) <= self.clock().timestamp():
            logger.warning("auth_callback_rejected branch=state_expired")
            raise Problem(401, "INVALID_LOGIN")
        if not hmac.compare_digest(row["binding"], hashed(binding_cookie)):
            logger.warning("auth_callback_rejected branch=login_cookie_binding_mismatch")
            raise Problem(401, "INVALID_LOGIN")
        try:
            self.store.call(
                "delete_item",
                TableName=self.table,
                Key=attributes({"PK": row["PK"], "SK": "META"}),
                ConditionExpression="revision = :r",
                ExpressionAttributeValues=attributes({":r": row["revision"]}),
            )
        except Problem as exc:
            if exc.status == 412:
                logger.warning("auth_callback_rejected branch=state_already_consumed")
                raise Problem(401, "INVALID_LOGIN") from None
            raise
        tokens = self.provider.exchange(code, row["verifier"], row["nonce"])
        tokens.principal.require("form/read")
        cookie, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = self.clock()
        maximum = now + self.config.max_lifetime
        self._put(
            {
                "PK": "AUTHSESSION#" + hashed(cookie),
                "SK": "META",
                "revision": 1,
                "tokens": self._encode(tokens),
                "csrf": csrf,
                "absolute": stamp(maximum),
                "idle": stamp(min(maximum, now + self.config.idle_lifetime)),
                "expires": int(maximum.timestamp()),
                "revoked": False,
            }
        )
        if old_cookie:
            # Rotate opaque identifier and revoke the previous browser account session.
            self.revoke(old_cookie)
        return {
            "cookie": cookie,
            "setCookie": self._cookie(cookie, int((maximum - now).total_seconds())),
        }

    @staticmethod
    def _cookie(value, max_age):
        return f"__Host-form_session={value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}"

    @staticmethod
    def _encode(tokens):
        return json_text(
            {
                "subject": tokens.principal.subject,
                "scopes": sorted(tokens.principal.scopes),
                "access": tokens.access_token,
                "refresh": tokens.refresh_token,
                "expiry": tokens.access_expires,
            }
        )

    @staticmethod
    def _decode(row):
        from datetime import datetime

        data = load_json(row["tokens"])
        return TokenBundle(
            Principal(data["subject"], frozenset(data["scopes"])),
            data["access"],
            data["refresh"],
            datetime.fromisoformat(data["expiry"]),
        )

    def _valid(self, cookie):
        from datetime import datetime

        if not isinstance(cookie, str) or not 20 <= len(cookie) <= 128:
            raise Problem(401, "SESSION_REQUIRED")
        row = self._get("AUTHSESSION", hashed(cookie))
        if not row or row.get("revoked"):
            raise Problem(401, "SESSION_REVOKED")
        if (
            min(datetime.fromisoformat(row["absolute"]), datetime.fromisoformat(row["idle"]))
            <= self.clock()
        ):
            self.revoke(cookie)
            raise Problem(401, "SESSION_EXPIRED")
        return row

    def tokens(self, cookie):
        # No in-process lock: independent Lambda workers coordinate through row CAS.
        for _ in range(30):
            row = self._valid(cookie)
            bundle = self._decode(row)
            if bundle.access_expires > self.clock() + timedelta(seconds=30):
                return bundle
            now = self.clock().timestamp()
            if row.get("leaseUntil", 0) > now:
                self.sleep(0.025)
                continue
            owner = secrets.token_hex(16)
            fenced = {
                **row,
                "revision": int(row["revision"]) + 1,
                "leaseOwner": owner,
                "leaseUntil": int(now) + 20,
            }
            try:
                self._put(fenced, int(row["revision"]))
            except Problem as exc:
                if exc.status == 412:
                    continue
                raise
            try:
                renewed = self.provider.renew(bundle.refresh_token)
                if renewed.principal != bundle.principal:
                    self.revoke(cookie)
                    raise Problem(401, "IDENTITY_CHANGED")
                updated = {
                    **fenced,
                    "revision": fenced["revision"] + 1,
                    "tokens": self._encode(renewed),
                    "leaseUntil": 0,
                }
                self._put(updated, fenced["revision"])
                return renewed
            except Problem as exc:
                # Never resurrect a logged-out row. If CAS lost, revoke newly minted token.
                if exc.status == 412:
                    if "renewed" in locals():
                        self.provider.revoke(renewed.refresh_token)
                    raise Problem(401, "SESSION_REVOKED") from None
                if exc.status == 401:
                    self.revoke(cookie)
                # For transient issuer failure keep the lease: retry inside rotation grace.
                raise
        raise Problem(503, "REFRESH_IN_PROGRESS")

    def authenticate(self, cookie):
        return self.tokens(cookie).principal

    def session_info(self, cookie):
        principal = self.authenticate(cookie)
        row = self._valid(cookie)
        return {
            "subject": principal.subject,
            "csrfToken": row["csrf"],
            "expiresAt": row["absolute"],
        }

    def _csrf(self, cookie, origin, csrf):
        row = self._valid(cookie)
        if (
            origin != self.config.origin
            or not isinstance(csrf, str)
            or not hmac.compare_digest(row["csrf"], csrf)
        ):
            raise Problem(403, "CSRF_FAILED")
        return row

    def authorize_mutation(self, cookie, origin, csrf):
        # Validate CSRF before attempting refresh or changing any session state.
        self._csrf(cookie, origin, csrf)
        principal = self.authenticate(cookie)
        principal.require("form/write")
        return principal

    def revoke(self, cookie):
        for _ in range(6):
            row = self._get("AUTHSESSION", hashed(cookie))
            if not row or row.get("revoked"):
                return
            bundle = self._decode(row)
            tombstone = {k: v for k, v in row.items() if k not in ("tokens", "csrf", "leaseOwner")}
            tombstone.update(revision=int(row["revision"]) + 1, revoked=True, leaseUntil=0)
            queue = {
                "PK": "REVOCATION#" + str(self.clock().date()),
                "SK": hashed(cookie),
                "refresh": bundle.refresh_token,
                "revision": 1,
                "expires": int(self.clock().timestamp()) + 8 * 86400,
            }
            try:
                self.store.call(
                    "transact_write_items",
                    TransactItems=[
                        {
                            "Put": {
                                "TableName": self.table,
                                "Item": attributes(tombstone),
                                "ConditionExpression": "revision = :r",
                                "ExpressionAttributeValues": attributes({":r": row["revision"]}),
                            }
                        },
                        {"Put": {"TableName": self.table, "Item": attributes(queue)}},
                    ],
                )
                self._revoke_queued(queue)
                return
            except Problem as exc:
                if exc.status != 412:
                    raise
        raise Problem(503, "REVOCATION_RETRY_REQUIRED")

    def _revoke_queued(self, row):
        try:
            self.provider.revoke(row["refresh"])
            self.store.call(
                "delete_item",
                TableName=self.table,
                Key=attributes({"PK": row["PK"], "SK": row["SK"]}),
            )
        except Problem:
            return  # Durable outbox is retried by scheduled worker; local session is revoked.

    def drain_revocations(self):
        for days in range(9):
            day = str((self.clock() - timedelta(days=days)).date())
            for row in self.store.query(self.table, "REVOCATION#" + day):
                self._revoke_queued(row)

    def logout(self, cookie, origin, csrf):
        self._csrf(cookie, origin, csrf)
        self.revoke(cookie)
        return self._cookie("", 0)
