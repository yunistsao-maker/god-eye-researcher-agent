"""REQUEST interceptor for the tools gateway.

The gateway has already validated the JWT (CUSTOM_JWT inbound auth) before this runs, so the
token's claims can be trusted here. For every tools/call to one of our Lambda targets we
overwrite arguments._caller with the token's `sub`, which is how the Lambda tools know who is
calling and enforce ownership. A value the client sends for _caller is always replaced.

Managed targets (the `web-search` connector) do not declare `_caller`, so their arguments are
passed through untouched; any `_caller` a client adds for them is removed.
"""
from __future__ import annotations

import base64
import json
from typing import Any

# Lambda targets whose tools take `_caller` (see tools/schemas/build_schemas.py).
CALLER_TARGETS = ("project-tools___", "data-tools___", "web-tools___")


def _claims(auth_header: str) -> dict:
    token = auth_header.split(" ", 1)[1] if auth_header.lower().startswith("bearer ") else auth_header
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, json.JSONDecodeError):
        return {}


def _deny(body: dict, message: str) -> dict:
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": 200,
                "body": {"jsonrpc": "2.0", "id": body.get("id"), "error": {"code": -32001, "message": message}},
            }
        },
    }


def handler(event: dict, context: Any) -> dict:
    mcp = event.get("mcp") or {}
    request = mcp.get("gatewayRequest") or {}
    body = request.get("body") or {}
    if body.get("method") != "tools/call":
        return {"interceptorOutputVersion": "1.0", "mcp": {"transformedGatewayRequest": {"body": body}}}

    headers = {k.lower(): v for k, v in (request.get("headers") or {}).items()}
    sub = _claims(headers.get("authorization", "")).get("sub")
    if not sub:
        return _deny(body, "No user identity in the access token")

    params = dict(body.get("params") or {})
    args = dict(params.get("arguments") or {})
    if str(params.get("name", "")).startswith(CALLER_TARGETS):
        args["_caller"] = sub
    else:
        args.pop("_caller", None)
    params["arguments"] = args
    return {"interceptorOutputVersion": "1.0", "mcp": {"transformedGatewayRequest": {"body": {**body, "params": params}}}}
