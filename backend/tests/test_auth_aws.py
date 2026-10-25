"""Cryptographic JWT tests + Moto session tests. Cognito HTTP responses are simulated."""

import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import jwt
import test_dynamo
from cryptography.hazmat.primitives.asymmetric import rsa

from form_backend.aws.auth_sessions import DurableSessions, hashed
from form_backend.aws.cognito import Cognito, CognitoConfig
from form_backend.aws.runtime import bff_handler, domain_handler
from form_backend.core import Problem, utcnow
from form_backend.local_sessions import FakeIdentityProvider
from form_backend.sessions import SessionConfig


class CognitoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.private.public_key()))
        cls.jwk.update(kid="test-key", use="sig", alg="RS256")

    def setUp(self):
        self.clock = utcnow
        self.config = CognitoConfig(
            "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Test",
            "https://test.auth.us-east-1.amazoncognito.com",
            "client123",
            "synthetic-client-secret",
            "https://form.test/auth/callback",
        )
        self.requests = []
        self.raw = None

        def transport(request):
            self.requests.append(request)
            if request.url.path.endswith("jwks.json"):
                return httpx.Response(200, json={"keys": [self.jwk]})
            if request.url.path == "/oauth2/revoke":
                return httpx.Response(200)
            return httpx.Response(200, json=self.raw)

        self.provider = Cognito(self.config, httpx.Client(transport=httpx.MockTransport(transport)))

    def token(self, use="access", **updates):
        now = int(utcnow().timestamp())
        body = {
            "iss": self.config.issuer,
            "sub": "user-A",
            "iat": now,
            "exp": now + 600,
            "token_use": use,
            "client_id": self.config.client_id,
            "scope": "openid email form/read form/write",
        }
        if use == "id":
            body.update(aud=self.config.client_id, nonce="nonce123", email_verified=True)
        body.update(updates)
        return jwt.encode(body, self.private, algorithm="RS256", headers={"kid": "test-key"})

    def test_code_pkce_exchange_verifies_both_tokens_without_browser_exposure(self):
        self.raw = {
            "access_token": self.token(),
            "id_token": self.token("id"),
            "refresh_token": "server-refresh",
        }
        bundle = self.provider.exchange("one-time-code", "server-pkce-verifier", "nonce123")
        self.assertEqual(bundle.principal.subject, "user-A")
        posted = parse_qs(self.requests[0].content.decode())
        self.assertEqual(posted["code_verifier"], ["server-pkce-verifier"])
        self.assertEqual(posted["grant_type"], ["authorization_code"])
        self.assertTrue(self.requests[0].headers["authorization"].startswith("Basic "))
        self.assertNotIn("server-refresh", repr(bundle))
        url = urlsplit(self.provider.authorize_url("state", "nonce", "challenge"))
        self.assertEqual(parse_qs(url.query)["code_challenge_method"], ["S256"])

    def test_rejects_wrong_issuer_client_type_scope_expiry_subject_and_nonce(self):
        for update in (
            {"iss": "https://attacker.test"},
            {"client_id": "other"},
            {"token_use": "id"},
            {"scope": "openid"},
            {"exp": 1},
            {"sub": ""},
            {"iat": int(utcnow().timestamp()) + 1000},
        ):
            with self.subTest(update=update), self.assertRaises(Problem):
                self.provider.verify(self.token(**update), "access")
        with self.assertRaises(Problem):
            self.provider.verify(self.token("id"), "id", "wrong-nonce")
        with self.assertRaises(Problem):
            self.provider.verify(
                jwt.encode(
                    {"sub": "user-A"}, "attacker-secret-long-enough-for-tests", algorithm="HS256"
                ),
                "access",
            )

    def test_unknown_signing_key_and_forged_signature_fail_closed(self):
        token = self.token()
        stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        forged = jwt.encode(
            jwt.decode(token, options={"verify_signature": False}),
            stranger,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        for value in (forged, "malformed", token[:-6] + "abcdef"):
            with self.assertRaises(Problem):
                self.provider.verify(value, "access")

    def test_refresh_checks_identity_and_rotated_refresh_token(self):
        self.raw = {"access_token": self.token(), "refresh_token": "rotated-refresh"}
        self.assertEqual(self.provider.renew("old-refresh").refresh_token, "rotated-refresh")
        self.raw["access_token"] = self.token(client_id="other")
        with self.assertRaises(Problem):
            self.provider.renew("old-refresh")

    def test_unverified_email_and_mismatched_id_access_subjects_are_rejected(self):
        for updates in ({"email_verified": False}, {"sub": "user-B"}):
            self.raw = {
                "access_token": self.token(),
                "id_token": self.token("id", **updates),
                "refresh_token": "refresh",
            }
            with self.assertRaises(Problem):
                self.provider.exchange("code", "verifier", "nonce123")

    def test_public_endpoints_are_pinned_and_redirects_not_followed(self):
        with self.assertRaises(ValueError):
            CognitoConfig(
                "https://attacker.test",
                self.config.domain,
                "client",
                "secret",
                self.config.redirect_uri,
            )
        provider = Cognito(
            self.config,
            httpx.Client(
                transport=httpx.MockTransport(
                    lambda r: httpx.Response(302, headers={"Location": "https://attacker.test"})
                )
            ),
        )
        with self.assertRaises(Problem):
            provider.exchange("code", "verifier", "nonce")


class DurableSessionTests(unittest.TestCase):
    cognito_issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Test"

    def setUp(self):
        test_dynamo.DynamoContract.setUp(self)
        self.issuer = FakeIdentityProvider(("user-A", "user-B"), self.clock)
        self.manager = DurableSessions(self.store, self.issuer, clock=self.clock)

    def login(self, subject="user-A", manager=None, old=None):
        manager = manager or self.manager
        begin = manager.begin()
        code = self.issuer.issue_code(subject, begin["codeChallenge"], begin["nonce"])
        return manager.callback(begin["state"], code, begin["bindingCookie"], old)

    def test_persists_across_manager_recreation_and_cookie_only_is_opaque(self):
        grant = self.login()
        restored = DurableSessions(self.store, self.issuer, clock=self.clock)
        info = restored.session_info(grant["cookie"])
        self.assertEqual(info["subject"], "user-A")
        self.assertNotIn("access", json.dumps(info))
        for marker in ("Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"):
            self.assertIn(marker, grant["setCookie"])
        self.assertNotIn("user-A", grant["cookie"])
        row = self.manager._get("AUTHSESSION", hashed(grant["cookie"]))
        self.assertNotEqual(row["PK"], grant["cookie"])

    def test_state_nonce_binding_single_use_and_unknown_invitation(self):
        begin = self.manager.begin()
        code = self.issuer.issue_code("user-A", begin["codeChallenge"], begin["nonce"])
        with self.assertRaises(Problem):
            self.manager.callback(begin["state"], code, "wrong-binding")
        restored = DurableSessions(self.store, self.issuer, clock=self.clock)
        restored.callback(begin["state"], code, begin["bindingCookie"])
        with self.assertRaises(Problem):
            self.manager.callback(begin["state"], code, begin["bindingCookie"])
        with self.assertRaises(Problem):
            self.issuer.issue_code("uninvited", "x", "y")

    def test_seven_day_maximum_and_shorter_configuration(self):
        cookie = self.login()["cookie"]
        self.clock.advance(days=7)
        with self.assertRaises(Problem):
            self.manager.authenticate(cookie)
        with self.assertRaises(ValueError):
            DurableSessions(self.store, self.issuer, SessionConfig(max_lifetime=timedelta(days=8)))

    def test_csrf_logout_revocation_and_account_switch(self):
        a = self.login()["cookie"]
        csrf = self.manager.session_info(a)["csrfToken"]
        for origin, token in (
            ("https://evil.test", csrf),
            ("https://form.test", "wrong"),
            (None, csrf),
        ):
            with self.assertRaises(Problem):
                self.manager.authorize_mutation(a, origin, token)
        b = self.login("user-B", old=a)["cookie"]
        with self.assertRaises(Problem):
            self.manager.authenticate(a)
        self.assertEqual(self.manager.authenticate(b).subject, "user-B")
        with self.assertRaises(Problem):
            self.manager.authorize_mutation(b, "https://form.test", csrf)
        clear = self.manager.logout(
            b, "https://form.test", self.manager.session_info(b)["csrfToken"]
        )
        self.assertIn("Max-Age=0", clear)
        with self.assertRaises(Problem):
            self.manager.authenticate(b)

    def test_two_workers_refresh_once_without_global_lock(self):
        cookie = self.login()["cookie"]
        self.clock.advance(minutes=11)
        other = DurableSessions(self.store, self.issuer, clock=self.clock)
        renew = self.issuer.renew

        def slow(token):
            time.sleep(0.05)
            return renew(token)

        self.issuer.renew = slow
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(lambda m: m.authenticate(cookie), (self.manager, other)))
        self.assertEqual([p.subject for p in results], ["user-A", "user-A"])
        self.assertEqual(self.issuer.renewals, 1)

    def test_logout_during_refresh_cannot_resurrect_session(self):
        cookie = self.login()["cookie"]
        self.clock.advance(minutes=11)
        renew = self.issuer.renew

        def racing(token):
            self.manager.revoke(cookie)
            return renew(token)

        # Simulate token issuing just before revocation: return fresh bundle despite revoked old token.
        def minted_then_logout(token):
            result = renew(token)
            self.manager.revoke(cookie)
            return result

        self.issuer.renew = minted_then_logout
        with self.assertRaises(Problem):
            self.manager.authenticate(cookie)
        self.assertTrue(self.manager._get("AUTHSESSION", hashed(cookie))["revoked"])

    def test_issuer_outage_keeps_session_and_retry_after_lease(self):
        cookie = self.login()["cookie"]
        self.clock.advance(minutes=11)
        self.issuer.unavailable = True
        with self.assertRaises(Problem) as caught:
            self.manager.authenticate(cookie)
        self.assertEqual(caught.exception.status, 503)
        self.issuer.unavailable = False
        self.clock.advance(seconds=21)
        self.assertEqual(self.manager.authenticate(cookie).subject, "user-A")

    def test_logout_queues_failed_provider_revocation(self):
        cookie = self.login()["cookie"]
        csrf = self.manager.session_info(cookie)["csrfToken"]
        revoke = self.issuer.revoke
        self.issuer.revoke = lambda token: (_ for _ in ()).throw(Problem(503, "OUTAGE"))
        self.manager.logout(cookie, "https://form.test", csrf)
        queued = tuple(self.store.query("accounts", "REVOCATION#" + str(self.clock().date())))
        self.assertEqual(len(queued), 1)
        self.issuer.revoke = revoke
        self.manager.drain_revocations()
        self.assertEqual(tuple(self.store.query("accounts", queued[0]["PK"])), ())

    def test_logout_does_not_require_successful_access_token_refresh(self):
        cookie = self.login()["cookie"]
        csrf = self.manager.session_info(cookie)["csrfToken"]
        self.clock.advance(minutes=11)
        self.issuer.unavailable = True
        self.manager.logout(cookie, "https://form.test", csrf)
        self.assertTrue(self.manager._get("AUTHSESSION", hashed(cookie))["revoked"])

    def test_invalid_login_callback_cannot_clear_an_existing_account_cookie(self):
        cookie = self.login()["cookie"]
        with patch("form_backend.aws.runtime.sessions", return_value=self.manager):
            response = bff_handler(
                self.event(
                    "GET", "/auth/callback", cookie, rawQueryString="state=forged&code=forged"
                ),
                None,
            )
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(response["cookies"], [])
        self.assertEqual(self.manager.authenticate(cookie).subject, "user-A")

    def test_callback_accepts_and_validates_oauth_issuer_parameter(self):
        begin = self.manager.begin()
        code = self.issuer.issue_code("user-A", begin["codeChallenge"], begin["nonce"])
        event = self.event(
            "GET",
            "/auth/callback",
            rawQueryString=urlencode(
                {"state": begin["state"], "code": code, "iss": self.cognito_issuer}
            ),
        )
        event["cookies"] = ["__Host-form_login=" + begin["bindingCookie"]]
        with (
            patch("form_backend.aws.runtime.sessions", return_value=self.manager),
            patch.dict("os.environ", {"COGNITO_ISSUER": self.cognito_issuer}),
        ):
            response = bff_handler(event, None)
        self.assertEqual(response["statusCode"], 303)
        self.assertEqual(response["headers"]["Location"], "/?mode=cloud")

    def test_callback_rejects_mismatched_oauth_issuer_without_consuming_state(self):
        begin = self.manager.begin()
        code = self.issuer.issue_code("user-A", begin["codeChallenge"], begin["nonce"])
        event = self.event(
            "GET",
            "/auth/callback",
            rawQueryString=urlencode(
                {"state": begin["state"], "code": code, "iss": "https://wrong.example"}
            ),
        )
        event["cookies"] = ["__Host-form_login=" + begin["bindingCookie"]]
        with (
            patch("form_backend.aws.runtime.sessions", return_value=self.manager),
            patch.dict("os.environ", {"COGNITO_ISSUER": self.cognito_issuer}),
        ):
            response = bff_handler(event, None)
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(json.loads(response["body"])["error"]["code"], "INVALID_LOGIN")
        self.assertIsNotNone(self.manager._get("LOGIN", hashed(begin["state"])))

    def test_callback_logs_oauth_error_category_without_logging_query_values(self):
        marker = "SENSITIVE-TEST-MARKER"
        event = self.event(
            "GET",
            "/auth/callback",
            rawQueryString=urlencode(
                {"state": "unused-state", "error": "access_denied", "error_description": marker}
            ),
        )
        with (
            patch("form_backend.aws.runtime.sessions", return_value=self.manager),
            self.assertLogs("form_backend.aws.runtime", level="WARNING") as captured,
        ):
            response = bff_handler(event, None)
        self.assertEqual(response["statusCode"], 401)
        self.assertIn("branch=oauth_error_response", captured.output[0])
        self.assertNotIn(marker, "\n".join(captured.output))

    def test_domain_unhandled_failure_logs_only_safe_category_and_request_id(self):
        marker = "PRIVATE-DYNAMODB-DETAIL"
        event = self.event("GET", "/v1/nutrition/foods")
        event["requestContext"]["requestId"] = "gateway-request-123"
        event["headers"]["authorization"] = "Bearer PRIVATE-ACCESS-TOKEN"
        with (
            patch(
                "form_backend.aws.runtime.request",
                return_value=(
                    "GET",
                    "/v1/nutrition/foods",
                    {"authorization": "Bearer PRIVATE-ACCESS-TOKEN"},
                    "{}",
                    {},
                ),
            ),
            patch("form_backend.aws.runtime.provider") as provider,
            patch("form_backend.aws.runtime.store", side_effect=RuntimeError(marker)),
            self.assertLogs("form_backend.aws.runtime", level="ERROR") as captured,
        ):
            provider.return_value.verify.return_value = {
                "sub": "user-A",
                "scope": "form/read",
            }
            response = domain_handler(event, None)
        logs = "\n".join(captured.output)
        self.assertEqual(response["statusCode"], 503)
        self.assertIn("layer=domain", logs)
        self.assertIn("request_id=gateway-request-123", logs)
        self.assertIn("error_type=RuntimeError", logs)
        self.assertNotIn(marker, logs)
        self.assertNotIn("PRIVATE-ACCESS-TOKEN", logs)

    def test_bff_forwards_bodyless_get_and_preserves_mutation_payload(self):
        cookie = self.login()["cookie"]
        tokens = self.manager.tokens(cookie)
        info = self.manager.session_info(cookie)
        requests = []

        def upstream(request):
            requests.append(request)
            return httpx.Response(200, json={"data": {"items": []}})

        original_client = httpx.Client
        transport = httpx.MockTransport(upstream)
        with (
            patch("form_backend.aws.runtime.sessions", return_value=self.manager),
            patch(
                "form_backend.aws.runtime.httpx.Client",
                side_effect=lambda **kwargs: original_client(transport=transport, **kwargs),
            ),
            patch.dict(
                "os.environ",
                {"DOMAIN_API_ORIGIN": "https://api-id.execute-api.us-east-1.amazonaws.com"},
            ),
        ):
            # Neither an absent body nor a caller-supplied GET body is forwarded.
            for fields in ({}, {"body": '{"ignored":true}'}):
                result = bff_handler(
                    self.event(
                        "GET",
                        "/api/v1/nutrition/foods",
                        cookie,
                        rawQueryString="limit=1&cursor=opaque%2Bcursor",
                        **fields,
                    ),
                    None,
                )
                self.assertEqual(result["statusCode"], 200)
                self.assertEqual(result["headers"]["X-Form-Subject"], "user-A")
                sent = requests[-1]
                self.assertEqual(sent.method, "GET")
                self.assertEqual(sent.url.path, "/v1/nutrition/foods")
                self.assertEqual(dict(sent.url.params), {"limit": "1", "cursor": "opaque+cursor"})
                self.assertEqual(sent.headers["authorization"], "Bearer " + tokens.access_token)
                self.assertEqual(sent.content, b"")
                self.assertNotIn("transfer-encoding", sent.headers)
                self.assertNotIn("content-length", sent.headers)

            payload = '{"name":"Mock food"}'
            result = bff_handler(
                self.event(
                    "POST",
                    "/api/v1/nutrition/foods",
                    cookie,
                    body=payload,
                    headers={
                        "origin": self.manager.config.origin,
                        "x-csrf-token": info["csrfToken"],
                        "content-type": "application/json",
                        "idempotency-key": "test-mutation-key",
                    },
                ),
                None,
            )
            self.assertEqual(result["statusCode"], 200)
            self.assertEqual(requests[-1].content, payload.encode())
            self.assertEqual(requests[-1].headers["idempotency-key"], "test-mutation-key")

    def test_bff_upstream_503_logs_only_status_and_correlation_ids(self):
        cookie = self.login()["cookie"]
        marker = "UPSTREAM-PRIVATE-DETAIL"
        transport = httpx.MockTransport(
            lambda request: httpx.Response(
                503,
                json={"message": marker},
                headers={"apigw-requestid": "domain-gateway-request-456"},
            )
        )
        original_client = httpx.Client

        def client_with_mock_transport(*args, **kwargs):
            return original_client(transport=transport, *args, **kwargs)

        event = self.event("GET", "/api/v1/nutrition/foods", cookie)
        event["requestContext"]["requestId"] = "bff-gateway-request-123"
        with (
            patch("form_backend.aws.runtime.sessions", return_value=self.manager),
            patch(
                "form_backend.aws.runtime.httpx.Client",
                side_effect=client_with_mock_transport,
            ),
            patch.dict(
                "os.environ",
                {"DOMAIN_API_ORIGIN": "https://api-id.execute-api.us-east-1.amazonaws.com"},
            ),
            self.assertLogs("form_backend.aws.runtime", level="ERROR") as captured,
        ):
            response = bff_handler(event, None)
        logs = "\n".join(captured.output)
        self.assertEqual(response["statusCode"], 503)
        self.assertIn("layer=bff_upstream", logs)
        self.assertIn("status=503", logs)
        self.assertIn("request_id=bff-gateway-request-123", logs)
        self.assertIn("upstream_request_id=domain-gateway-request-456", logs)
        self.assertNotIn(marker, logs)

    def event(self, method, path, cookie="", **fields):
        return {
            "version": "2.0",
            "rawPath": path,
            "requestContext": {"http": {"method": method}},
            "cookies": ["__Host-form_session=" + cookie],
            "headers": {},
            **fields,
        }

    def test_bff_http_response_contains_no_tokens_or_caller_identity_override(self):
        cookie = self.login()["cookie"]
        with patch("form_backend.aws.runtime.sessions", return_value=self.manager):
            response = bff_handler(self.event("GET", "/auth/session", cookie), None)
            self.assertEqual(response["statusCode"], 200)
            body = json.loads(response["body"])
            self.assertEqual(body["subject"], "user-A")
            self.assertNotIn("refresh", response["body"])
            self.assertIn("no-store", response["headers"]["Cache-Control"])
            rejected = bff_handler(
                self.event(
                    "POST",
                    "/api/v1/workouts/exercises",
                    cookie,
                    headers={"x-owner-id": "user-B"},
                    body='{"name":"fake"}',
                ),
                None,
            )
            self.assertEqual(rejected["statusCode"], 403)
        self.assertEqual(domain_handler(self.event("GET", "/v1/me"), None)["statusCode"], 401)
