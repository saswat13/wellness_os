"""Generate OpenAPI from the same route/model registry that local tests exercise."""

import json
import re
from pathlib import Path
from typing import Any

from .api import ROUTES
from .models import Empty, EntityResponse, ErrorResponse, Page


def openapi():
    schemas = {}

    def schema(model):
        value = model.model_json_schema(by_alias=True, ref_template="#/components/schemas/{model}")
        schemas.update(value.pop("$defs", {}))
        schemas[model.__name__] = value
        return {"$ref": "#/components/schemas/" + model.__name__}

    error = schema(ErrorResponse)
    paths: dict[str, Any] = {}
    for route in ROUTES:
        scope = "form/read" if route.method == "GET" else "form/write"
        list_result = route.operation.endswith((":list", ":history", ":active"))
        response = Page[route.read] if list_result else EntityResponse[route.read]  # type: ignore[name-defined]  # Runtime generated Pydantic schema.
        parameters = [
            {"name": name, "in": "path", "required": True, "schema": {"type": "string"}}
            for name in re.findall(r"\{(\w+)\}", route.path)
        ]
        if route.method != "GET":
            parameters.append(
                {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": True,
                    "schema": {"type": "string", "format": "uuid"},
                }
            )
            if not route.operation.endswith(":create"):
                parameters.append(
                    {
                        "name": "If-Match",
                        "in": "header",
                        "required": True,
                        "schema": {"type": "string", "pattern": '^"(0|[1-9][0-9]*)"$'},
                    }
                )
        if list_result:
            parameters.extend(
                {"name": n, "in": "query", "schema": {"type": t}}
                for n, t in (("limit", "integer"), ("cursor", "string"))
            )
        if route.operation in ("diary:day", "goals:get"):
            parameters.append(
                {"name": "date", "in": "query", "schema": {"type": "string", "format": "date"}}
            )
        if route.operation == "session:list":
            parameters.extend(
                {"name": n, "in": "query", "schema": {"type": "string", "format": "date-time"}}
                for n in ("from", "to")
            )
        op: dict[str, Any] = {
            "operationId": route.operation.replace(":", "_")
            + "_"
            + route.method.lower()
            + "_"
            + str(len(paths)),
            "security": [{"CognitoAccess": [scope]}],
            "parameters": parameters,
            "responses": {
                str(route.status): {
                    "description": "Success",
                    **(
                        {}
                        if route.status == 204
                        else {"content": {"application/json": {"schema": schema(response)}}}
                    ),
                }
            },
        }
        for status in (400, 401, 403, 404, 409, 412, 413, 422, 428, 503):
            op["responses"][str(status)] = {
                "description": "Sanitized error",
                "content": {"application/json": {"schema": error}},
            }
        if route.request:
            op["requestBody"] = {
                "required": route.request is not Empty,
                "content": {"application/json": {"schema": schema(route.request)}},
            }
        paths.setdefault(route.path, {})[route.method.lower()] = op
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "FORM v1 domain contracts",
            "version": "1.0.0",
            "description": "Versioned domain contract. AWS adapters are locally tested; browser transport uses same-origin /api/v1 with opaque BFF sessions. No infrastructure is deployed.",
        },
        "paths": paths,
        "components": {
            "schemas": schemas,
            "securitySchemes": {
                "CognitoAccess": {
                    "type": "oauth2",
                    "flows": {
                        "authorizationCode": {
                            "authorizationUrl": "https://cognito-not-configured.invalid/oauth2/authorize",
                            "tokenUrl": "https://cognito-not-configured.invalid/oauth2/token",
                            "scopes": {
                                "form/read": "Read own FORM data",
                                "form/write": "Mutate own FORM data",
                            },
                        }
                    },
                },
                "BffSession": {"type": "apiKey", "in": "cookie", "name": "__Host-form_session"},
            },
        },
    }


if __name__ == "__main__":
    destination = Path(__file__).resolve().parents[1] / "contracts" / "openapi-v1.json"
    destination.write_text(json.dumps(openapi(), indent=2) + "\n")
