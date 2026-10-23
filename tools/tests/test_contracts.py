"""The hand-written validators must agree with the JSON Schemas in contracts/, and the tool
definitions must pass the real AgentCore control-plane request validation."""
import base64
import copy
import json
from pathlib import Path

import botocore.session
import jsonschema
import pytest
from botocore.validate import ParamValidator

from fixtures import BAD_SPEC, COMPARE_SPEC, TIMELINE_SPEC, finding

ROOT = Path(__file__).resolve().parents[2]
FINDING_SCHEMA = json.loads((ROOT / "contracts" / "finding.schema.json").read_text())
SPEC_SCHEMA = json.loads((ROOT / "contracts" / "ui-spec.schema.json").read_text())


def _bad_findings():
    base = finding("f-1")
    cases = []
    for mutate in [
        lambda f: f.update(confidence=1.5),
        lambda f: f.update(dataShape="pie"),
        lambda f: f.update(findingId="F_1"),
        lambda f: f.update(extra=True),
        lambda f: f["sources"].append({"title": "x", "url": "ftp://x"}),
        lambda f: f["entities"].append({"id": "e-x", "type": "alien", "name": "X"}),
        lambda f: f.pop("summary"),
        lambda f: f["relations"].append({"from": "e-a", "to": "e-b", "type": "likes"}),
    ]:
        f = copy.deepcopy(base)
        mutate(f)
        cases.append(f)
    return cases


CLAIM = {"claimId": "c-1-1", "text": "多數廠商保留 AOI 並加上 AI 複判", "status": "corroborated", "independentSources": 2,
         "supporting": 2, "contradicting": 0,
         "evidence": [{"docId": "d-0123456789ab", "quote": "保留既有 AOI 設備", "stance": "supports", "charStart": 10, "charEnd": 19,
                       "url": "https://example.com/a", "title": "A", "publisher": "example.com", "duplicateOf": None,
                       "sourceType": "news", "score": 0.65}]}


def _with_claims(*claims):
    f = finding("f-1")
    f["claims"] = list(claims)
    return f


def test_finding_validator_matches_schema():
    from common.validate import validate_finding
    good = finding("f-1")
    for ok in (good, _with_claims(CLAIM)):
        jsonschema.validate(ok, FINDING_SCHEMA)
        assert validate_finding(ok) == []
    bad_claims = [_with_claims({**CLAIM, "status": "maybe"}), _with_claims({**CLAIM, "evidence": []}),
                  _with_claims({**CLAIM, "evidence": [{**CLAIM["evidence"][0], "docId": "doc-1"}]}),
                  _with_claims({**CLAIM, "claimId": "C1"})]
    for bad in _bad_findings() + bad_claims:
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(bad, FINDING_SCHEMA)
        assert validate_finding(bad), bad


def test_spec_validator_matches_schema():
    from common.validate import validate_spec
    good = [COMPARE_SPEC, TIMELINE_SPEC,
            {"specVersion": 1, "dataShape": "metrics", "root": {"component": "MetricBars", "props": {"items": "$.data.items", "label": "label", "value": "value", "unit": "unit"}}},
            {"specVersion": 1, "dataShape": "list", "title": "重點", "root": {"component": "KeyPoints", "props": {"items": "$.keyPoints"}}}]
    bad = [BAD_SPEC,
           {**COMPARE_SPEC, "specVersion": 2},
           {"specVersion": 1, "dataShape": "comparison", "root": {"component": "Compare", "props": {"columns": "$.data.columns", "rows": "javascript:x"}}},
           {"specVersion": 1, "dataShape": "comparison", "root": {"component": "Compare", "props": {"columns": "$.data.columns", "rows": "$.data.rows", "onClick": "x"}}},
           {"specVersion": 1, "dataShape": "timeline", "root": {"component": "Timeline", "props": {"items": "$.data.items", "label": "when"}}}]
    for s in good:
        jsonschema.validate(s, SPEC_SCHEMA)
        assert validate_spec(s) == [], s
    for s in bad:
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(s, SPEC_SCHEMA)
        assert validate_spec(s), s


def test_tool_definitions_pass_gateway_api_validation():
    import subprocess, sys
    subprocess.run([sys.executable, str(ROOT / "tools" / "schemas" / "build_schemas.py")], check=True, capture_output=True)
    model = botocore.session.get_session().get_service_model("bedrock-agentcore-control")
    shape = model.operation_model("CreateGatewayTarget").input_shape
    for name in ["project_tools", "data_tools", "web_tools"]:
        tools = json.loads((ROOT / "tools" / "schemas" / f"{name}.json").read_text())
        params = {
            "gatewayIdentifier": "gw-123",
            "name": name.replace("_", "-"),
            "targetConfiguration": {"mcp": {"lambda": {"lambdaArn": "arn:aws:lambda:us-west-2:111122223333:function:x", "toolSchema": {"inlinePayload": tools}}}},
            "credentialProviderConfigurations": [{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
        }
        report = ParamValidator().validate(params, shape)
        assert not report.has_errors(), report.generate_report()


def _jwt(claims):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'RS256'})}.{enc(claims)}.sig"


def test_interceptor_injects_and_overwrites_caller():
    import interceptor
    body = {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "project-tools___project_list", "arguments": {"_caller": "spoofed"}}}
    out = interceptor.handler({"mcp": {"gatewayRequest": {"headers": {"Authorization": "Bearer " + _jwt({"sub": "real-sub"})}, "body": body}}}, None)
    args = out["mcp"]["transformedGatewayRequest"]["body"]["params"]["arguments"]
    assert args["_caller"] == "real-sub" and out["interceptorOutputVersion"] == "1.0"


def test_interceptor_leaves_managed_web_search_arguments_alone():
    import interceptor
    body = {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": {"name": "web-search___WebSearch", "arguments": {"query": "半導體 生成式 AI", "maxResults": 5, "_caller": "x"}}}
    out = interceptor.handler({"mcp": {"gatewayRequest": {"headers": {"authorization": "Bearer " + _jwt({"sub": "real-sub"})}, "body": body}}}, None)
    assert out["mcp"]["transformedGatewayRequest"]["body"]["params"]["arguments"] == {"query": "半導體 生成式 AI", "maxResults": 5}


def test_research_tools_match_what_the_gateway_exposes():
    """The agent asks for exact tool names; they must be what deploy_agentcore.py creates."""
    import sys
    sys.path.insert(0, str(ROOT / "agent"))
    sys.path.insert(0, str(ROOT / "scripts"))
    import deploy_agentcore
    from research_agent.gateway import RESEARCH_TOOLS
    exposed = {f"{name}___{t['name']}" for name, (_, tools) in deploy_agentcore.TOOL_TARGETS.items() for t in tools}
    connector = deploy_agentcore.web_search_target_request("gw")
    exposed |= {f"{connector['name']}___{c['name']}" for c in connector["targetConfiguration"]["mcp"]["connector"]["configurations"]}
    assert RESEARCH_TOOLS <= exposed, RESEARCH_TOOLS - exposed


def test_interceptor_passes_other_methods_and_denies_without_sub():
    import interceptor
    listing = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    out = interceptor.handler({"mcp": {"gatewayRequest": {"body": listing}}}, None)
    assert out["mcp"]["transformedGatewayRequest"]["body"] == listing
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "x", "arguments": {}}}
    denied = interceptor.handler({"mcp": {"gatewayRequest": {"headers": {}, "body": call}}}, None)
    assert denied["mcp"]["transformedGatewayResponse"]["body"]["error"]["code"] == -32001


def test_fetch_page_blocks_private_addresses():
    import web_tools
    from common.toolkit import ToolError
    for url in ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/", "http://10.0.0.5/", "file:///etc/passwd"]:
        with pytest.raises(ToolError):
            web_tools.fetch_page({"_caller": "x", "url": url})


def test_text_extraction():
    import web_tools
    p = web_tools._TextExtractor()
    p.feed("<html><head><title>報告</title><script>evil()</script></head><body><nav>menu</nav><p>第一段</p><p>Second   para</p></body></html>")
    assert p.title == "報告" and p.text() == "第一段\nSecond para"
