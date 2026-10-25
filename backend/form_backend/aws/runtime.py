"""HTTP API v2 Lambda entrypoints. Configuration is server-only and fails closed."""

import base64
import hmac
import logging
import os
import re
from datetime import timedelta
from functools import lru_cache
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import boto3
import httpx
from botocore.config import Config

from ..api import ROUTES
from ..core import Principal, Problem, json_text
from ..service import Service
from ..sessions import SessionConfig
from .auth_sessions import DurableSessions
from .cognito import Cognito, CognitoConfig
from .dynamo import (
    DynamoAccounts,
    DynamoCatalog,
    DynamoNutrition,
    DynamoTraining,
    DynamoUnitOfWork,
    Store,
    Tables,
    client,
)
from .pagination import DynamoAPI

logger = logging.getLogger(__name__)
_SAFE_LOG_VALUE = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")


def _safe_log_value(value):
    return value if isinstance(value, str) and _SAFE_LOG_VALUE.fullmatch(value) else "unknown"


def _gateway_request_id(event):
    return _safe_log_value(event.get("requestContext", {}).get("requestId"))


def _log_unhandled_failure(layer, event, exc):
    details = getattr(exc, "response", {})
    error = details.get("Error", {}) if isinstance(details, dict) else {}
    metadata = details.get("ResponseMetadata", {}) if isinstance(details, dict) else {}
    logger.error(
        "request_failure layer=%s request_id=%s error_type=%s aws_error_code=%s aws_request_id=%s",
        layer,
        _gateway_request_id(event),
        _safe_log_value(type(exc).__name__),
        _safe_log_value(error.get("Code")),
        _safe_log_value(metadata.get("RequestId")),
    )


@lru_cache
def store():
    return Store(
        client(),
        Tables(
            *(
                os.environ[k]
                for k in ("ACCOUNTS_TABLE", "TRAINING_TABLE", "NUTRITION_TABLE", "CATALOG_TABLE")
            )
        ),
    )


@lru_cache
def provider(role="bff"):
    client_secret = ""
    if role == "bff":
        cognito = boto3.client(
            "cognito-idp",
            region_name="us-east-1",
            config=Config(
                retries={"mode": "standard", "total_max_attempts": 3},
                connect_timeout=2,
                read_timeout=5,
            ),
        )
        client_secret = cognito.describe_user_pool_client(
            UserPoolId=os.environ["COGNITO_POOL_ID"], ClientId=os.environ["COGNITO_CLIENT_ID"]
        )["UserPoolClient"]["ClientSecret"]
    return Cognito(
        CognitoConfig(
            os.environ["COGNITO_ISSUER"],
            os.environ["COGNITO_DOMAIN"],
            os.environ["COGNITO_CLIENT_ID"],
            client_secret,
            os.environ["APP_ORIGIN"] + "/auth/callback",
        )
    )


@lru_cache
def sessions():
    maximum = int(os.environ.get("SESSION_MAX_SECONDS", "604800"))
    return DurableSessions(
        store(),
        provider(),
        SessionConfig(origin=os.environ["APP_ORIGIN"], max_lifetime=timedelta(seconds=maximum)),
    )


@lru_cache
def cursor_key():
    secrets = boto3.client(
        "secretsmanager",
        region_name="us-east-1",
        config=Config(
            retries={"mode": "standard", "total_max_attempts": 3}, connect_timeout=2, read_timeout=5
        ),
    )
    return secrets.get_secret_value(SecretId=os.environ["CURSOR_SECRET_ARN"])[
        "SecretString"
    ].encode()


def response(status, body=None, *, cookies=None, headers=None):
    return {
        "statusCode": status,
        "headers": {
            "Cache-Control": "no-store, private",
            "Pragma": "no-cache",
            "Content-Type": "application/json",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            **(headers or {}),
        },
        "cookies": cookies or [],
        "body": "" if body is None else json_text(body),
    }


def error(problem):
    request_id = str(uuid4())
    result = response(
        problem.status,
        {
            "error": {
                "code": problem.code,
                "message": "Request could not be completed",
                "requestId": request_id,
            }
        },
    )

    result["headers"]["X-Request-Id"] = request_id
    if problem.status in (429, 503):
        result["headers"]["Retry-After"] = "1"
    return result


def request(event):
    if event.get("version") != "2.0":
        raise Problem(400, "HTTP_API_V2_REQUIRED")
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw, validate=True).decode()
    if len(raw.encode()) > 256 * 1024:
        raise Problem(413, "PAYLOAD_TOO_LARGE")
    query = parse_qs(event.get("rawQueryString", ""), keep_blank_values=True)
    if any(len(v) != 1 for v in query.values()):
        raise Problem(400, "DUPLICATE_QUERY_FIELD")
    return method, path, headers, raw, {k: v[0] for k, v in query.items()}


def domain_handler(event, context):
    try:
        method, path, headers, body, query = request(event)
        if not headers.get("authorization", "").startswith("Bearer "):
            raise Problem(401, "AUTHENTICATION_REQUIRED")
        claims = provider("domain").verify(headers["authorization"][7:], "access")
        principal = Principal(claims["sub"], frozenset(claims["scope"].split()))
        uow = DynamoUnitOfWork(store())  # Never share request read/write sets across invocations.
        api = DynamoAPI(
            Service(
                uow,
                DynamoTraining(uow),
                DynamoNutrition(uow),
                DynamoAccounts(uow),
                DynamoCatalog(store()),
            ),
            cursor_key(),
        )
        result = api.handle(
            method, path, principal=principal, body=body, headers=headers, query=query
        )
        if result.status in (429, 503):
            result.headers["Retry-After"] = "1"
        return response(result.status, result.body, headers=result.headers)
    except Problem as exc:
        if exc.status >= 500:
            logger.error(
                "request_failure layer=domain request_id=%s status=%d problem_code=%s",
                _gateway_request_id(event),
                exc.status,
                _safe_log_value(exc.code),
            )
        return error(exc)
    except Exception as exc:
        # Log only safe error categories and request IDs, never event or AWS exception data.
        _log_unhandled_failure("domain", event, exc)
        return error(Problem(503, "SERVICE_UNAVAILABLE"))


def read_cookies(event):
    jar = SimpleCookie()
    jar.load("; ".join(event.get("cookies", ())))
    return {k: v.value for k, v in jar.items()}


def bff_handler(event, context):
    try:
        if event.get("source") == "aws.events":
            sessions().drain_revocations()
            return {"statusCode": 204}
        method, path, headers, body, query = request(event)
        cookies = read_cookies(event)
        cookie = cookies.get("__Host-form_session", "")
        manager = sessions()
        if path == "/auth/login" and method == "GET":
            if query:
                raise Problem(400, "UNKNOWN_QUERY_FIELD")
            login = manager.begin()
            return response(
                302,
                cookies=[
                    f"__Host-form_login={login['bindingCookie']}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600"
                ],
                headers={
                    "Location": provider().authorize_url(
                        login["state"], login["nonce"], login["codeChallenge"]
                    )
                },
            )
        if path == "/auth/callback" and method == "GET":
            if "error" in query:
                logger.warning("auth_callback_rejected branch=oauth_error_response")
                raise Problem(401, "INVALID_LOGIN")
            if not {"code", "state"}.issubset(query):
                logger.warning("auth_callback_rejected branch=missing_required_parameter")
                raise Problem(401, "INVALID_LOGIN")
            if set(query) - {"code", "state", "iss"}:
                logger.warning("auth_callback_rejected branch=unexpected_parameter")
                raise Problem(401, "INVALID_LOGIN")
            if not query["code"] or not query["state"]:
                logger.warning("auth_callback_rejected branch=empty_required_parameter")
                raise Problem(401, "INVALID_LOGIN")
            if "iss" in query and not hmac.compare_digest(
                query["iss"].encode(), os.environ["COGNITO_ISSUER"].encode()
            ):
                logger.warning("auth_callback_rejected branch=issuer_mismatch")
                raise Problem(401, "INVALID_LOGIN")
            grant = manager.callback(
                query["state"], query["code"], cookies.get("__Host-form_login", ""), cookie or None
            )
            return response(
                303,
                cookies=[
                    grant["setCookie"],
                    "__Host-form_login=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
                ],
                headers={"Location": "/?mode=cloud"},
            )
        if path == "/auth/session" and method == "GET":
            return response(200, manager.session_info(cookie))
        if path == "/auth/logout" and method == "POST":
            cleared = manager.logout(cookie, headers.get("origin"), headers.get("x-csrf-token", ""))
            # Cognito logout clears its managed-login cookie; prompt=login also prevents silent account reuse.
            from urllib.parse import urlencode

            location = (
                provider().config.domain
                + "/logout?"
                + urlencode(
                    {"client_id": provider().config.client_id, "logout_uri": manager.config.origin}
                )
            )
            return response(200, {"logoutUrl": location}, cookies=[cleared])
        if not path.startswith("/api/v1/") or ".." in path or "%" in path:
            raise Problem(404, "NOT_FOUND")
        internal = path[4:]
        if not any(r.method == method and r.match(internal) for r in ROUTES):
            raise Problem(404, "NOT_FOUND")
        if method != "GET":
            manager.authorize_mutation(
                cookie, headers.get("origin"), headers.get("x-csrf-token", "")
            )
        tokens = manager.tokens(cookie)
        origin = os.environ["DOMAIN_API_ORIGIN"]
        url = urlsplit(origin)
        if (
            url.scheme != "https"
            or not url.netloc.endswith(".execute-api.us-east-1.amazonaws.com")
            or url.path
        ):
            raise Problem(503, "INVALID_CONFIGURATION")
        forwarded = {
            k: headers[k] for k in ("if-match", "idempotency-key", "content-type") if k in headers
        }
        forwarded["authorization"] = "Bearer " + tokens.access_token
        with httpx.Client(timeout=25, follow_redirects=False) as http:
            upstream = http.request(
                method, origin + internal, params=query, content=body, headers=forwarded
            )
        if upstream.status_code >= 500:
            upstream_request_id = next(
                (
                    upstream.headers[key]
                    for key in ("apigw-requestid", "x-amzn-requestid", "x-amz-apigw-id")
                    if key in upstream.headers
                ),
                None,
            )
            logger.error(
                "request_failure layer=bff_upstream request_id=%s status=%d upstream_request_id=%s",
                _gateway_request_id(event),
                upstream.status_code,
                _safe_log_value(upstream_request_id),
            )
        safe = {
            k: upstream.headers[k]
            for k in ("etag", "location", "idempotency-replayed", "x-request-id", "retry-after")
            if k in upstream.headers
        }
        safe["X-Form-Subject"] = tokens.principal.subject
        result = response(upstream.status_code, headers=safe)
        result["body"] = upstream.text
        return result
    except Problem as exc:
        if exc.status >= 500:
            logger.error(
                "request_failure layer=bff request_id=%s status=%d problem_code=%s",
                _gateway_request_id(event),
                exc.status,
                _safe_log_value(exc.code),
            )
        result = error(exc)
        if exc.status == 401 and event.get("rawPath") not in ("/auth/login", "/auth/callback"):
            result["cookies"] = [DurableSessions._cookie("", 0)]
        return result
    except Exception as exc:
        _log_unhandled_failure("bff", event, exc)
        return error(Problem(503, "SERVICE_UNAVAILABLE"))
