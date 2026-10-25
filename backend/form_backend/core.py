"""Transport-independent errors, trusted identity and lossless JSON helpers."""

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from hashlib import sha256
from typing import Any


class Problem(Exception):
    def __init__(self, status: int, code: str, message: str = "Request could not be completed."):
        self.status, self.code, self.message = status, code, message
        super().__init__(code)


@dataclass(frozen=True)
class Principal:
    """Only a verified adapter/fake test issuer constructs this; never parse request owner IDs."""

    subject: str
    scopes: frozenset[str] = frozenset({"form/read", "form/write"})
    invited: bool = True

    def require(self, scope: str) -> None:
        if not self.subject or not self.invited:
            raise Problem(403, "INVITATION_REQUIRED")
        if scope not in self.scopes:
            raise Problem(403, "INSUFFICIENT_SCOPE")


def json_text(value: Any) -> str:
    """Decimals stay JSON numbers, without a float conversion or display rounding."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Nonfinite decimal")
        text = format(value, "f")
        return text.rstrip("0").rstrip(".") if "." in text else text
    if isinstance(value, datetime):
        return json.dumps(
            value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )
    if isinstance(value, date):
        return json.dumps(value.isoformat())
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(json.dumps(k) + ":" + json_text(v) for k, v in sorted(value.items()))
            + "}"
        )
    if isinstance(value, (tuple, list)):
        return "[" + ",".join(json_text(v) for v in value) + "]"
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def digest(value: Any) -> str:
    return sha256(json_text(value).encode()).hexdigest()


def load_json(raw: str | bytes) -> Any:
    def invalid(_):
        raise ValueError("Nonfinite input")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    return json.loads(
        raw, parse_float=Decimal, parse_constant=invalid, object_pairs_hook=unique_object
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
