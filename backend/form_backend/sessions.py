"""Session interfaces, configuration and token DTOs shared by local and AWS adapters."""

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from hashlib import sha256
from threading import RLock
from typing import Protocol

from .core import Principal


@dataclass(frozen=True)
class TokenBundle:
    principal: Principal
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    access_expires: datetime


class IdentityProvider(Protocol):
    def exchange(self, code: str, verifier: str, nonce: str) -> TokenBundle: ...
    def renew(self, refresh_token: str) -> TokenBundle: ...
    def revoke(self, refresh_token: str) -> None: ...


@dataclass(frozen=True)
class SessionConfig:
    origin: str = "https://form.test"
    max_lifetime: timedelta = timedelta(days=7)
    idle_lifetime: timedelta = timedelta(days=7)

    def __post_init__(self):
        from urllib.parse import urlsplit

        url = urlsplit(self.origin)
        if url.scheme != "https" or not url.netloc or url.path or url.query or url.fragment:
            raise ValueError("Exact HTTPS origin required")
        if self.max_lifetime <= timedelta(0) or self.idle_lifetime <= timedelta(0):
            raise ValueError("Session lifetimes must be positive")


@dataclass
class ServerSession:
    tokens: TokenBundle
    csrf: str
    absolute_expiry: datetime
    idle_expiry: datetime


class SessionRepository(Protocol):
    lock: RLock

    def get(self, cookie_hash: str) -> ServerSession | None: ...
    def put(self, cookie_hash: str, session: ServerSession) -> None: ...
    def revoke(self, cookie_hash: str) -> None: ...


def challenge(verifier):
    return base64.urlsafe_b64encode(sha256(verifier.encode()).digest()).decode().rstrip("=")
