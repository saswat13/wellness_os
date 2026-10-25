"""Explicit loopback-only offline BFF + fake issuer. NEVER packaged or deployed.

Run --fake-auth deliberately. Proxies the existing local Next server; uses real
strict domain dispatch, memory repositories and the fake PKCE/session abstraction.
HTTP loopback uses a distinct test-only cookie; it does not verify production TLS.
"""

import argparse
import html
import http.client
import os
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import RLock
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

from form_backend.api import API
from form_backend.core import Problem, json_text
from form_backend.local_sessions import FakeIdentityProvider, MemorySessions, Sessions
from form_backend.models import Exercise, Food, GoalWrite, Nutrients, Profile
from form_backend.repositories import (
    MemoryAccounts,
    MemoryCatalog,
    MemoryNutrition,
    MemoryTraining,
    MemoryUnitOfWork,
)
from form_backend.service import Service
from form_backend.sessions import SessionConfig

COOKIE = "form_loopback_test_session"


class Clock:
    def __init__(self):
        self.offset = timedelta()

    def __call__(self):
        return datetime.now(timezone.utc) + self.offset


class LocalApplication:
    def __init__(self, origin, upstream):
        self.origin, self.upstream = origin, upstream
        self.clock = Clock()
        self.uow = MemoryUnitOfWork(self.clock)
        self.provider = FakeIdentityProvider(("pilot-A", "pilot-B"), self.clock)
        self.sessions = Sessions(
            self.provider, MemorySessions(), SessionConfig(origin="https://form.test"), self.clock
        )
        self.training, self.nutrition, self.accounts = (
            MemoryTraining(self.uow),
            MemoryNutrition(self.uow),
            MemoryAccounts(self.uow),
        )
        self.catalog = MemoryCatalog(
            exercises=(
                Exercise(
                    id="system-lat-pulldown",
                    name="Single-arm cable lat pulldown",
                    unilateral=True,
                    primary_muscle="Lats",
                    equipment="Cable",
                ),
                Exercise(
                    id="system-flyes",
                    name="Seated cable chest flyes",
                    primary_muscle="Chest",
                    equipment="Cable",
                ),
                Exercise(
                    id="system-row",
                    name="Seated cable row (wide grip)",
                    primary_muscle="Upper back",
                    equipment="Cable",
                ),
                Exercise(
                    id="system-smith",
                    name="Incline Smith machine chest press",
                    primary_muscle="Chest",
                    equipment="Smith machine",
                ),
            ),
            foods=(
                Food(
                    id="system-rice",
                    name="Mock cooked rice",
                    preparation="cooked",
                    per100g=Nutrients(calories=130, protein=2.7, carbs=28, fat=0.3),
                ),
            ),
            clock=self.clock,
        )
        self.api = API(
            Service(self.uow, self.training, self.nutrition, self.accounts, self.catalog)
        )
        self.lock = RLock()
        self.logins = {}
        # Mock invited accounts have normal server defaults, never imported browser histories.
        from form_backend.core import Principal

        for subject in self.provider.invited:
            p = Principal(subject)
            self.accounts.put(p, "profile", Profile(name=subject), 0)
            goals = GoalWrite(
                calories=2400,
                protein=160,
                carbs=290,
                fat=67,
                effective_from=self.clock().astimezone(ZoneInfo("America/Los_Angeles")).date(),
            )
            self.api.service.save_goals(p, goals, 0)


class Handler(BaseHTTPRequestHandler):
    server_version = "FORM-loopback-test"

    def log_message(self, *_args):
        pass

    def send(self, status, body=None, headers=None, *, raw=False):
        content = body if raw else (json_text(body).encode() if body is not None else b"")
        self.send_response(status)
        self.send_header("Content-Type", (headers or {}).get("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-store, private")
        self.send_header("Content-Length", str(len(content)))
        for key, value in (headers or {}).items():
            if key.lower() != "content-type":
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)

    def handle_request(self):
        app = self.server.app
        try:
            if self.headers.get("Host") != urlsplit(app.origin).netloc:
                raise Problem(403, "INVALID_HOST")
            parsed = urlsplit(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            if any(len(v) != 1 for v in query.values()):
                raise Problem(400, "DUPLICATE_QUERY_FIELD")
            query = {k: v[0] for k, v in query.items()}
            jar = SimpleCookie()
            jar.load(self.headers.get("Cookie", ""))
            cookie = jar[COOKIE].value if COOKIE in jar else ""
            length = int(self.headers.get("Content-Length", "0"))
            if length > 256 * 1024:
                raise Problem(413, "PAYLOAD_TOO_LARGE")
            raw = self.rfile.read(length) if length else b"{}"
            method = self.command
            if path == "/auth/login" and method == "GET":
                login = app.sessions.begin()
                app.logins[login["state"]] = login
                form = f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>FORM offline fake sign-in</title><body><h1>Offline fake identity provider</h1><p>Local integration test only. No Cognito users or AWS resources.</p><form method="post" action="/auth/callback"><input type="hidden" name="state" value="{html.escape(login["state"])}"><button name="subject" value="pilot-A">Sign in as pilot A</button><button name="subject" value="pilot-B">Sign in as pilot B</button></form></body></html>'''.encode()
                self.send(
                    200,
                    form,
                    {
                        "Content-Type": "text/html; charset=utf-8",
                        "Set-Cookie": f"form_loopback_login={login['bindingCookie']}; HttpOnly; SameSite=Lax; Path=/",
                    },
                    raw=True,
                )
                return
            if path == "/auth/callback" and method == "POST":
                if self.headers.get("Origin") != app.origin:
                    raise Problem(403, "CSRF_FAILED")
                fields = parse_qs(raw.decode())
                state = fields.get("state", [""])[0]
                subject = fields.get("subject", [""])[0]
                login = app.logins.pop(state, None)
                if not login:
                    raise Problem(401, "INVALID_LOGIN")
                code = app.provider.issue_code(subject, login["codeChallenge"], login["nonce"])
                binding = jar["form_loopback_login"].value if "form_loopback_login" in jar else ""
                grant = app.sessions.callback(state, code, binding)
                if cookie:
                    app.sessions.repository.revoke(sha256(cookie.encode()).hexdigest())
                self.send(
                    303,
                    headers={
                        "Location": "/?mode=cloud",
                        "Set-Cookie": f"{COOKIE}={grant['cookie']}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800",
                    },
                )
                return
            if path == "/auth/session" and method == "GET":
                self.send(200, app.sessions.session_info(cookie))
                return
            if path == "/auth/logout" and method == "POST":
                if self.headers.get("Origin") != app.origin:
                    raise Problem(403, "CSRF_FAILED")
                app.sessions.logout(
                    cookie, "https://form.test", self.headers.get("X-CSRF-Token", "")
                )
                self.send(
                    200,
                    {"logoutUrl": "/?mode=cloud"},
                    {"Set-Cookie": f"{COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"},
                )
                return
            if path == "/__test/expire" and method == "POST":
                expected = os.environ.get("FORM_LOCAL_TEST_KEY")
                if not expected or self.headers.get("X-Form-Test-Key") != expected:
                    raise Problem(403, "TEST_CONTROL_DENIED")
                app.sessions.repository.revoke(sha256(cookie.encode()).hexdigest())
                self.send(204)
                return
            if path.startswith("/api/v1/"):
                p = app.sessions.authenticate(cookie)
                if method != "GET":
                    if self.headers.get("Origin") != app.origin:
                        raise Problem(403, "CSRF_FAILED")
                    app.sessions.authorize_mutation(
                        cookie, "https://form.test", self.headers.get("X-CSRF-Token", "")
                    )
                with app.lock:
                    result = app.api.handle(
                        method,
                        path[4:],
                        principal=p,
                        body=raw,
                        headers=dict(self.headers),
                        query=query,
                    )
                self.send(
                    result.status, result.body, {**result.headers, "X-Form-Subject": p.subject}
                )
                return
            # Only proxy local frontend traffic. Never accept request-selected upstreams.
            conn = http.client.HTTPConnection("127.0.0.1", app.upstream, timeout=60)
            headers = {
                k: v
                for k, v in self.headers.items()
                if k.lower() not in ("host", "cookie", "authorization", "connection")
            }
            headers["Host"] = f"127.0.0.1:{app.upstream}"
            conn.request(method, self.path, body=raw if length else None, headers=headers)
            upstream = conn.getresponse()
            body = upstream.read()
            self.send_response(upstream.status)
            for k, v in upstream.getheaders():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            conn.close()
        except Problem as error:
            self.send(
                error.status,
                {
                    "error": {
                        "code": error.code,
                        "message": "Local request rejected",
                        "requestId": str(uuid4()),
                    }
                },
            )
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send(
                503,
                {
                    "error": {
                        "code": "LOCAL_SERVICE_UNAVAILABLE",
                        "message": "Local test service failed",
                        "requestId": str(uuid4()),
                    }
                },
            )

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request
    do_HEAD = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fake-auth", action="store_true", required=True)
    parser.add_argument("--port", type=int, default=3001)
    parser.add_argument("--frontend-port", type=int, default=3000)
    args = parser.parse_args()
    if args.port != 3001 or args.frontend_port != 3000:
        parser.error("Only loopback ports 3001 -> 3000 are allowlisted")
    app = LocalApplication("http://127.0.0.1:3001", 3000)
    server = ThreadingHTTPServer(("127.0.0.1", 3001), Handler)
    server.app = app
    print("FORM offline fake BFF: http://127.0.0.1:3001; explicit test identities only", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
