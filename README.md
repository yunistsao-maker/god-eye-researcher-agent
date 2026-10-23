# God Eye Researcher

輸入一個研究主題，Supervisor agent 拆解成子題與「需求清單」、平行派出 sub-agents 上網研究，每個子題完成就即時串流到畫面：先用通用卡片顯示內容，客製 sub-UI 生成好再替換上去，同時長出關聯圖。每個結論都要對得回原文：sub-agent 讀過的網頁存成專案文件，主張必須附上逐字引文，後端核對引文確實出現在網頁裡，再依獨立發布者數量標成「已佐證／單一來源／有爭議」。綜合報告逐句引用主張（`[C3]`），寫完再逐句查核、修正沒有根據的句子。專案可以存到 S3、帶著舊結果重新研究，或封存清理。

設計文件：見 Claude Docs 上的「動態研究平台設計」與「研究代理 v2 規劃」。資料契約：[`contracts/events.md`](contracts/events.md)。評測：[`eval/README.md`](eval/README.md)。

## 架構

```
Browser ──HTTPS──> CloudFront ─┬─ /            -> S3 (React app)
   │                           ├─ /research/*  -> AgentCore Gateway「god-eye-agents」(HTTP target) -> Runtime: research supervisor
   │                           └─ /mcp         -> AgentCore Gateway「god-eye-tools」 (MCP)          -> Lambda tools
   └──WebSocket (Cognito)──> AppSync Events  <──publish (IAM)── Lambda tools
```

| 元件 | 位置 | 說明 |
| --- | --- | --- |
| Agents gateway | `scripts/deploy_agentcore.py` | 無 protocol type 的 gateway；Runtime target 不能掛在 MCP gateway 上，所以和工具分開 |
| Tools gateway | 同上 | MCP gateway，三個 Lambda target 加上 AgentCore 內建的 Web Search connector（target `web-search`，不需 API key）；REQUEST interceptor 從已驗證的 JWT 取出 `sub`，寫入我們 Lambda 工具的 `_caller` |
| Research runtime | `agent/` | Strands supervisor：規劃（子題＋需求清單）→ 平行 sub-agents（搜尋、讀網頁、寫出附引文的主張）→ `finding_write` → sub-UI spec → 檢查需求涵蓋、矛盾與缺口 → 針對薄弱需求補充研究 → 串流撰寫引用 `[C#]` 的報告 → 逐句查核與修正；invocation 立刻回傳，研究以 async task 在背景進行；watchdog 送心跳並取消停滯的 agent；收到 `stop` 會取消所有 agent 並結束自己的 AgentCore session |
| Tool Lambdas | `tools/src/` | `project-tools`、`data-tools`（含主張驗證、涵蓋度、報告查核結果）、`web-tools`（`fetch_page` 讀網頁並登記為專案文件、`search_web` 第二搜尋來源、`url_check` 檢查失效連結；主要搜尋交給 Web Search connector）、interceptor、cleanup 步驟 |
| Base stack | `infra/stacks/base_stack.py` | S3、DynamoDB、Cognito、AppSync Events、Lambdas、Step Functions 清理流程、gateway 與 runtime 的 IAM role |
| Web stack | `infra/stacks/web_stack.py` | CloudFront + S3；把兩個 gateway 代理在同一個網域下，瀏覽器不需要 CORS |
| Frontend | `frontend/` | React + Vite；`mock` 模式完全在瀏覽器內模擬，`live` 模式連 AWS |

身分一路傳遞：使用者的 Cognito access token → agents gateway（JWT 驗證）→ `JWT_PASSTHROUGH` → runtime（再驗一次同一個 JWT，`Authorization` header 在 allowlist）→ supervisor 用同一個 token 呼叫 tools gateway → interceptor 寫入 `_caller` → Lambda 檢查專案擁有者。

## 即時進度與 watchdog

研究過程中，Runtime 直接用 IAM 發佈「進度事件」到 AppSync（`agent.activity`、`agent.heartbeat`、`agent.stalled`、`synthesis.delta`）。這些事件不存檔，只為了讓畫面隨時顯示每個 agent 在做什麼；要保存的資料（findings、sub-UI、報告）仍然經過 tools gateway 寫入。

| 機制 | 做法 | 設定（runtime 環境變數） |
| --- | --- | --- |
| 活動回報 | Strands 的每個 token、思考片段、工具呼叫都會更新該 agent 的「最後活動時間」；換步驟（搜尋、閱讀、寫入…）時發佈 `agent.activity` | — |
| 心跳 | 每 10 秒發佈 `agent.heartbeat`；每 30 秒呼叫 `project_save` 更新 `updatedAt`，重新整理頁面時也能判斷研究是否還活著（也順便發現研究已被停止） | — |
| 停滯偵測 | 某個 LLM 步驟超過 `STALL_SEC` 沒有任何 token 或工具呼叫，或超過 `STEP_BUDGET_SEC`，watchdog 就取消它並重試一次；再停滯就放棄該子題，其餘照常完成 | `STALL_SEC=120`、`STEP_BUDGET_SEC=600` |
| 綜合報告 | 每輪子題完成後 Opus 5.5 檢查需求涵蓋（`coverage.updated`）、矛盾與缺口，針對薄弱或缺少的需求追加子題；最後把引用 `[C#]` 的報告逐字串流（`synthesis.delta`），再逐句查核（`verifying`），由 `synthesis_write` 存檔並發佈 `synthesis.ready` | 輪數由研究深度決定；`FOLLOW_UP_ROUNDS` 可設上限（0 關閉補充研究）；`MAX_PARALLEL=6` |

前端判斷：30 秒沒收到心跳就顯示「agent 可能已停止」。

## 證據骨幹：資料品質與知識結構

資料品質不交給模型自律，而是由後端的資料結構與規則保證。每個專案的知識是一張有型別的圖：

```
Project ─ Requirement（需求，q1…）◄── Coverage（covered / weak / missing，指向 Claim）
   │
   ├─ SubQuestion ─ Finding ─ Claim（原子主張）─ Evidence（逐字引文、立場、字元位置）─► Document
   │                   └─ Entity ◄─ Edge（mentions / shares_entity / supports / contradicts / causes）
   └─ Document（canonical URL、發布者、日期、來源類型、品質分數、duplicateOf）─ S3 文字快照
```

| 規則 | 做法 | 位置 |
| --- | --- | --- |
| 一個網頁一份文件 | 正規化網址（去掉追蹤參數、`www.`、錨點）後算出 `docId`；同一頁不會重抓，之後從 S3 快照讀 | `common/sources.py`、`web_tools.fetch_page` |
| 轉載不算獨立來源 | MinHash 相似度 ≥ 0.8 的頁面標 `duplicateOf`，佐證時算回原始發布者 | `common/sources.py` |
| 發布者 = 可註冊網域 | `news.example.co.uk` 與 `www.example.co.uk` 是同一個發布者 | `common/sources.py` |
| 來源分級 | 依網域判斷政府、標準、學術、研究機構、新聞、參考資料、社群、官方；再依日期、https 給 0–1 的品質分數；可用 `blockedDomains` 封鎖 | `common/sources.py` |
| 引文必須存在 | `finding_write` 在快照中找每段引文（忽略空白與全半形差異），找不到就丟掉；一半以上的主張沒有引文就退回重寫 | `data_tools.finding_write` |
| 主張狀態由規則決定 | ≥ 2 個獨立發布者支持＝已佐證；只有一個＝單一來源；有反駁引文＝有爭議 | `data_tools._verify_claims` |
| 涵蓋度驅動補充研究 | supervisor 依需求逐項標 covered / weak / missing，補充子題只針對 weak / missing | `orchestrator` |
| 報告逐句查核 | 報告只能引用主張 `[C#]`；寫完後逐句判斷是否被所引主張支持，不支持的句子改寫或刪除，並檢查連結是否失效；結果存在 `synthesis.verification` | `agent/research_agent/verify.py` |

畫面上：卡片列出查證過的主張（實心＝已佐證、半橘＝有爭議、空心＝單一來源），展開可看原文引文並直接跳到網頁中的那一段；研究計畫下方是需求涵蓋清單；報告上方顯示查核結果，點 `[C#]` 會在下方展開該主張與引文；右側「來源」列出去重、分類並評分過的網頁。

### 研究簡報

啟動研究時可以帶上簡報（都可省略），見 `contracts/events.md`：

| 欄位 | 用途 |
| --- | --- |
| `depth` | `quick`（2–3 個子題、不補充研究、約 450 字）、`standard`（預設，3–5 個子題、補充一輪、約 800 字）、`deep`（4–7 個子題、補充兩輪、約 1 500 字） |
| `audience` | 報告讀者，例如「製造業客戶的廠長」 |
| `startDate` | 只看這天之後的資料（`YYYY-MM-DD`） |
| `includeDomains` / `excludeDomains` | 優先或排除的網域 |
| `notes` | 其他要求 |

## 停止研究

研究進行中，畫面上的「停止研究」會停下整個 AgentCore 流程，已完成的 findings、sub-UI 與關聯圖都保留。停止分兩步，任何一步單獨成功都能停下來：

| 步驟 | 路徑 | 做的事 |
| --- | --- | --- |
| 1. 記錄停止 | 前端 → tools gateway → `project_stop` | 檢查擁有者，把專案改成 `stopped`、寫入 S3 快照、發佈 `project.stopped`。之後 `project_save` 不會再覆寫它，`finding_write` 等寫入工具一律拒絕（回傳 `stopped: true`），專案從此不再變動 |
| 2. 停下程序 | 前端 → agents gateway → runtime `{"action": "stop"}`（帶上 `project_stop` 回傳的 `runtimeSessionId`） | runtime 取消所有 agent 的模型呼叫（約 2 秒內），讓研究流程收尾，再用使用者的 token 呼叫 `StopRuntimeSession` 結束自己的 session；microVM 終止時，還在等 Bedrock 回應的 thread 也一起結束 |

- 第 2 步沒送到時（網路錯誤、runtime 沒回應），runtime 下一次心跳（30 秒內）的 `project_save` 會被拒絕並帶 `stopped: true`，它就自己停下並結束 session。
- 如果 agents gateway 沒有依 session header 把請求送到原本的 session，stop 會落在新的 session：runtime 直接結束研究所在的 session，再結束這個臨時 session。
- 同一個 session 裡還有其他專案在跑時，不會結束 session，只取消被停止的那個專案。
- 研究沒有在 15 秒內收尾（例如卡在某個工具呼叫），runtime 仍會強制結束 session。
- 為什麼不用 Lambda 呼叫 `StopRuntimeSession`：runtime 用 JWT authorizer，AgentCore 會拒絕對它的 SigV4 呼叫（`Authorization method mismatch`），所以只能帶使用者的 bearer token。runtime 需要知道自己的 ARN，部署腳本會在 `UpdateAgentRuntime` 時寫入 `RESEARCH_RUNTIME_ARN`。

停止的專案狀態是 `stopped`，可以「重新研究」（建立新專案並帶入已完成的結果），也可以封存清理；執行中的專案不能直接清理，要先停止。

## 先跑起來看看（不需要 AWS）

```bash
cd frontend
npm install
npm run dev        # public/config.json 預設 "mode": "mock"
```

## 部署到 AWS

需要：AWS CLI 憑證、Node 20+、Python 3.12+、CDK CLI（`npm i -g aws-cdk`）、已在 Bedrock 啟用 Claude Opus 5.5（supervisor 規劃）與 Claude Sonnet 5.5（研究 sub-agents、sub-UI 設計）。兩個模型都只能透過 inference profile 呼叫，預設用 `us.anthropic.claude-opus-5-5` 與 `us.anthropic.claude-sonnet-5-5`。預設 region 是 `us-west-2`；搜尋使用 [AgentCore Web Search](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html)，只在 us-east-1、us-east-2、us-west-2、eu-west-1、ap-southeast-2、ap-northeast-1 提供。

```bash
# 0. Python 依賴
python -m venv .venv && source .venv/bin/activate
pip install -r infra/requirements.txt -r agent/requirements.txt

# 1. 基礎資源
cd infra
cdk bootstrap                      # 每個帳號/region 一次
cdk deploy GodEyeBase              # POC 想讓 destroy 時刪光資料：加 -c destroyOnDelete=true
#   選用：-c blockedDomains=content-farm.example,spam.example   封鎖的網域（來源分數降到最低、不抓取）
#   選用：-c searchSecretArn=<Secrets Manager ARN>               第二搜尋來源與抓取備援（見下方）
cd ..

# 2. AgentCore：兩個 gateway、research runtime、targets（含 Web Search connector）
#    想換模型：先 export SUPERVISOR_MODEL_ID / WORKER_MODEL_ID（Bedrock inference profile id）
python scripts/deploy_agentcore.py
#    腳本最後會印出下一步的指令，並寫出 deploy-outputs.json 與 frontend/.env.local

# 3. 前端與 CloudFront
cd frontend && npm install && npm run build && cd ..
cd infra && cdk deploy GodEyeWeb -c agentsGatewayHost=<印出的 host> -c toolsGatewayHost=<印出的 host>

# 4. 建立使用者（self sign-up 預設關閉）
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
```

打開 `WebUrl`（GodEyeWeb 的 output），登入後就能開始研究。

**第二搜尋來源（選用）。** AgentCore Web Search 的中文結果較弱；若有 Tavily 或 Exa 的 API key，先存到 Secrets Manager（內容 `{"provider": "tavily", "apiKey": "..."}` 或 `"provider": "exa"`），部署 GodEyeBase 時加上 `-c searchSecretArn=<ARN>`。BaseStack 的 output `SecondarySearch` 會變成 `on`，`deploy_agentcore.py` 會據此在 runtime 設定 `SECONDARY_SEARCH=true`，sub-agent 就多了 `search_web` 工具；`fetch_page` 直接抓取失敗（例如需要 JavaScript 的頁面）時也會改用供應商的 extract API。沒有設定時一切照常，只用 AgentCore Web Search。

本機連 AWS 開發：`frontend/public/config.json` 改成 `"mode": "live"` 並填入 BaseStack outputs，`npm run dev` 會依 `.env.local` 把 `/research` 與 `/mcp` 代理到兩個 gateway。

## 測試

```bash
pip install pytest moto jsonschema
python -m pytest tools/tests -q            # tools、validators、證據規則、agent 端到端（moto + scripted LLM）、評測工具
python scripts/deploy_agentcore.py --validate-only   # 用 AWS API model 檢查每個 AgentCore request
cd frontend && npm test && npm run build
```

`tools/tests/test_agent_evidence.py` 跑一次完整的證據流程（網頁登記與去重、引文驗證、主張狀態、涵蓋度、報告查核與修正），並寫出 `contracts/fixtures/evidence-run.json`；前端的 `src/contract.test.ts` 用這份 fixture 重播事件與 `project_get`，確保前後端對資料格式的理解一致。報告品質用 `eval/` 評測（需要已部署的環境），見 [`eval/README.md`](eval/README.md)。

`tools/tests/test_agent_integration.py` 用真正的 orchestrator 呼叫真正的 Lambda handler（moto 模擬 DynamoDB/S3），只把 LLM 換成腳本，驗證整條路徑：計畫 → 平行 findings → 關聯 → 模板快取 → sub-UI → 完成、被拒的 finding 會帶錯誤重試、失敗會發佈 `project.failed`、使用者停止時流程在幾秒內收尾且不再寫入。`tools/tests/test_agent_stop.py` 測 runtime 的 `stop` action 與帶 bearer token 的 `StopRuntimeSession`。

## 清理

```bash
cd infra && cdk destroy GodEyeWeb GodEyeBase
```
AgentCore 資源（兩個 gateway 與 runtime）不在 CDK 裡，請在主控台或用 `bedrock-agentcore-control` 的 `delete-*` API 刪除。

## 首次部署要確認的事

這個版本沒有在真實帳號上部署過；以下幾點只能在 AWS 上驗證：

- Gateway 呼叫 Lambda target 時是否保留 schema 裡宣告的 `_caller` 參數（已在 inputSchema 宣告，interceptor 會覆寫）。
- 經 agents gateway 呼叫 research runtime 應回傳 `{"status": "accepted"}`，CloudWatch 裡的 runtime log 應看到研究開始。
- CloudFront 轉送 `Authorization` 與 MCP / AgentCore session headers 到 gateway（`web_stack.py` 的 `GatewayHeaders` origin request policy 明確列出）。
- Tools gateway 的 `tools/list` 應出現 `web-search___WebSearch`；若 research runtime log 出現 `tools gateway is missing`，代表 Web Search target 沒建好（檢查 region 與 gateway role 的 `bedrock-agentcore:InvokeWebSearch`）。
- 停止研究：按下「停止研究」後，runtime log 應出現 `research stop requested`、`ending AgentCore session`，之後該 session 不再有 log。若出現 `could not end the session`，代表帶 bearer token 的 `StopRuntimeSession` 被拒絕；研究本身仍已停止，session 會在閒置 15 分鐘後結束。
- Agents gateway 是否依 `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` 把 stop 送到研究所在的 session：runtime 回傳 `stopping` 代表有，`terminated` 代表落在新 session 但已處理。

## 已知限制

- **Runtime 目前沒有強制只接受 agents gateway 的呼叫。** `JWT_PASSTHROUGH` target 會把使用者 token 原封不動轉給 runtime，不會附上 transaction token；若 runtime 設了 `allowedWorkloadConfiguration`，每次呼叫都會得到 401 `Transaction token required`。所以 runtime 只驗 Cognito JWT：已登入的使用者可以繞過 gateway 直接呼叫 runtime，但權限和經過 gateway 時相同（工具仍由 tools gateway 驗 token、由 Lambda 檢查擁有者）。agents gateway 之後若加上 interceptor、guardrail 或 policy，就需要補上強制：改成 IAM（SigV4）inbound 的 runtime，用 resource-based policy 只允許 gateway 的 execution role，再把使用者 token 放在 `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` header 傳給 runtime。
- **Runtime 必須啟用 MMDSv2。** 2026-06-30 起沒有 `requireMMDSV2` 的 runtime 無法被呼叫；`CreateAgentRuntime` 不接受這個欄位，所以部署腳本建立 runtime 後會再呼叫一次 `UpdateAgentRuntime` 設定它。
- Cognito access token 預設 1 小時有效；研究超過這個時間，supervisor 呼叫工具會開始失敗。加上第二輪補充研究後，整個流程更容易接近這個上限。
- **被取消的 LLM 呼叫會在背景多佔一條 thread 最多 120 秒。** Strands 的同步呼叫要等 Bedrock 串流的 socket 讀取逾時才會結束，所以 watchdog 取消後直接放棄那條 thread（約 2 秒內回到流程），它會在讀取逾時後自行結束。
- 進度事件是盡力而為：AppSync 暫時連不上時會丟棄（log 會記錄數量），不影響研究本身；存檔資料不受影響。
- 停止的瞬間如果剛好有一個 `finding_write` 已通過檢查、正在寫入，它仍會完成，畫面上可能在「已停止」之後多出一張卡片；S3 的 `graph.json` 快照不會包含它。
- 引文核對是字面比對（忽略空白、全半形與引號差異）：sub-agent 改寫過的引文會被丟掉。這是刻意的，代價是偶爾少收一個主張。
- 「已佐證」只代表兩個獨立發布者說了同樣的事，不代表它是對的；來源類型與分數只是排序用的先驗，不判斷真偽。
- 報告逐句查核用的是同一個模型家族，只檢查「句子是否被所引主張支持」，不重新上網查證。
- **AgentCore Web Search 的索引以英文內容為主**，中文、日文查詢的結果較弱（有實測回報中文與日文查詢的結果品質偏低）。sub-agent 會同時用英文關鍵字查詢；設定第二搜尋來源（`searchSecretArn`）也有幫助。使用條款要求把引用與連結顯示給使用者，finding 卡片的「來源」與引文已經做到；也不允許大量擷取或儲存搜尋結果：我們只保存自己抓取的網頁快照，封存時只留文件的中繼資料。
