# 評測（P0）

每次改 agent（prompt、模型、搜尋策略、證據規則）之前先跑一次基準，改完再跑一次比較。沒有評測，就無法判斷一個改動讓報告變好還是變差。

## 內容

| 檔案 | 用途 |
| --- | --- |
| `questions.json` | 20 題（10 題繁中、10 題英文），涵蓋製造、金融、零售、科技、政策；每題有 `depth`、`audience`、`timeRange` 與 8–12 條二元評分準則，共 202 條（coverage、accuracy、sourcing、structure、insight、limits） |
| `metrics.py` | 不呼叫模型的確定性指標，從 `project_get` 結果計算 |
| `judge.py` | LLM 評審：一次看一份報告，逐條判定 pass / fail 並附一句理由 |
| `client.py` | 用和網頁相同的方式呼叫已部署的系統：agents gateway 啟動研究、tools gateway（MCP）讀回結果 |
| `evaluate.py` | 指令列：`run`、`score`、`compare` |

## 指標

| 指標 | 意義 | 越高越好？ |
| --- | --- | --- |
| `rubricScore` | 評分準則通過比例（LLM 評審） | 是 |
| `coverageShare` | 需求被標為 `covered` 的比例 | 是 |
| `corroboratedShare` | 主張中有 ≥ 2 個獨立發布者佐證的比例 | 是 |
| `citationPrecisionBefore` / `After` | 引用句被所引主張支持的比例（修正前 / 後） | 是 |
| `citedSentenceShare` | 報告中有引用的句子比例 | 是 |
| `primaryShare` | 政府、標準、學術、官方來源的比例 | 是 |
| `publishers` | 不同發布者數 | 是 |
| `communityShare` | 社群來源比例 | 否 |
| `unknownCitations`、`deadUrls` | 引用不存在的主張、失效連結 | 否 |
| `elapsedSec` | 耗時 | 否 |

評審設計參考近期研究：二元準則比 1–10 分的評分更穩定、也更接近人工評分；評審只判斷「報告本身做到了什麼」，不用自己的知識評斷事實，所以題庫不會因為世界改變而失效；並明確要求忽略長度與 Markdown 排版這兩個已知偏誤。和來源有關的準則，評審看的是附錄裡每個 `[C#]` 主張的狀態、發布者與來源類型，而不是猜測。

## 使用

需要一個已部署的環境與測試帳號。Cognito access token 一小時就過期，一次跑幾題即可。

```bash
export GOD_EYE_AGENTS_URL=https://<cloudfront 網域>         # agents gateway（同網域代理）
export GOD_EYE_TOOLS_URL=https://<cloudfront 網域>/mcp      # tools gateway
export GOD_EYE_TOKEN=<測試使用者的 Cognito access token>

# 1. 跑題目（結果寫到 eval/runs/<label>/，已列在 .gitignore：裡面有第三方網頁的引文）
python eval/evaluate.py run --label baseline --only mfg-zh-01,fin-en-01 --parallel 2
python eval/evaluate.py run --label baseline --depth quick          # 全部題目，改用 quick 省時間

# 2. 評分（--judge none 只算確定性指標；bedrock 需要 AWS 憑證與模型存取）
JUDGE_MODEL_ID=us.anthropic.claude-sonnet-5-5 python eval/evaluate.py score --label baseline --judge bedrock

# 3. 改完 agent 再跑一次，比較
python eval/evaluate.py run --label candidate --only mfg-zh-01,fin-en-01
python eval/evaluate.py score --label candidate
python eval/evaluate.py compare baseline candidate
```

`score` 會寫出 `scores.json`、`scores.csv` 與 `summary.md`（平均值、依語言／領域／深度分組、所有沒通過的準則與理由）。`compare` 對每個指標標出 better / worse。

已經跑過的題目會跳過，要重跑加 `--force`。

## 注意

- 評審與受測系統最好用不同模型（預設評審 Sonnet 5.5、研究 supervisor 是 Opus 5.5），降低自我偏好。
- 同一題每次結果都會不同；比較兩個版本時至少跑同一批 5–10 題，只看單題差異沒有意義。
- `eval/runs/` 不要 commit：AgentCore Web Search 的條款不允許大量保存搜尋結果，我們自己抓的網頁引文也只用於評測。
- 單元測試：`python -m pytest tools/tests/test_eval.py -q`（指標、評審 prompt 與解析、run/score/compare 的檔案流程，不需要 AWS）。
