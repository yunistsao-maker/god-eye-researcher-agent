PID = "p-20261022-1a2b3c4d"
ALICE = "sub-alice"
BOB = "sub-bob"


def finding(fid: str, shape: str = "comparison", entities=None, relations=None) -> dict:
    data = {
        "comparison": {"columns": ["環節", "階段", "主要用途"], "rows": [["工程知識檢索", "正式上線", "SOP 問答"], ["良率異常分析", "擴大試行", "根因建議"]]},
        "timeline": {"items": [{"when": "2024 H1", "what": "建立知識庫"}, {"when": "2025", "what": "混合部署"}]},
        "metrics": {"items": [{"label": "查詢時間", "value": -35, "unit": "%"}]},
        "list": {},
    }[shape]
    return {
        "findingId": fid,
        "projectId": PID,
        "question": "哪些環節最早導入生成式 AI？",
        "summary": "最早落地的是工程知識檢索與良率異常分析。",
        "keyPoints": ["知識檢索導入最快", "良率分析以輔助判讀為主"],
        "entities": entities if entities is not None else [
            {"id": "e-a", "type": "org", "name": "晶圓廠 A"},
            {"id": "e-rag", "type": "tech", "name": "RAG"},
        ],
        "relations": relations or [],
        "sources": [{"title": "Example report", "url": "https://example.com/report"}],
        "dataShape": shape,
        "data": data,
        "confidence": 0.8,
    }


COMPARE_SPEC = {"specVersion": 1, "dataShape": "comparison", "root": {"component": "Compare", "props": {"columns": "$.data.columns", "rows": "$.data.rows", "emphasizeColumn": 1}}}
TIMELINE_SPEC = {"specVersion": 1, "dataShape": "timeline", "root": {"component": "Timeline", "props": {"items": "$.data.items", "label": "when", "text": "what"}}}
BAD_SPEC = {"specVersion": 1, "dataShape": "list", "root": {"component": "RiskMatrix", "props": {"items": "$.keyPoints"}}}
