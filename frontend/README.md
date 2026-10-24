# God Eye Researcher: frontend

The research workspace: five screens that take a question from a plan you approve, through a live run
you can steer, to a report where every sentence leads back to its sources. Results stream in as AppSync
events (see `../contracts/events.md`). Each finding first shows as a generic card; when its sub-UI spec
arrives, the card swaps to one of four whitelisted components: `Compare`, `Timeline`, `MetricBars` or
`KeyPoints` (the swap waits while you hover over or focus inside the card).

Stack: Vite 5.4, React 18.3, TypeScript 5.6 (strict), aws-amplify 6, @aws-amplify/ui-react 6, plain CSS.
There are no UI, router or graph libraries; routes are hash routes and the graphs are SVG.

## Screens and routes

Hash routes, so every screen has a link that survives a reload and works from a static S3/CloudFront
origin (`src/router.ts`):

| route | screen | what it does |
| --- | --- | --- |
| `#/new`, `#/new?from={id}` | 新研究與計畫 (`screens/Compose.tsx`) | The question, three quick choices (reader, time range, aspects to cover), depth (with what each depth means), preferred and excluded domains, other notes. 「產生計畫」 asks the supervisor for a plan; the plan panel lets you rewrite, reorder, delete and add sub-questions and pick each one's presentation, shows the estimated sources and time, and offers the end-of-run email. If the question or settings change after the plan was made, it says so and offers to redo it. `?from=` re-researches a stopped or failed project. |
| `#/p/{id}/plan` | the same, for a draft | A draft (plan proposed, not started) reopens here with its saved plan. 「儲存計畫」 keeps your edits. |
| `#/p/{id}/run` | 研究進行中 (`screens/Run.tsx`) | Left: sub-questions with their state and coverage squares. Middle: findings as they arrive (filters 全部 / 有爭議 / 待補證), each with its sub-UI, claims and an evidence-strength footer; 改方向 (sticky while running). Right: counters (pages read, kept as evidence, syndicated copies merged, down-weighted sources) and the activity timeline. The header shows 第 n 步，共 m 步，約剩 x 分鐘, 「停止並用目前結果寫報告」 and 「停止」 (both confirm first). |
| `#/p/{id}/report` | 報告閱讀器 (`screens/Report.tsx`) | Table of contents with the evidence strength of each section; the executive summary with a strength mark per sentence; an evidence summary in the margin of every paragraph; numbered citation chips that open a citation card (the quote, a link that opens the page with the quote highlighted, the next source for the same claim); 「這一點來源說法不同」 boxes for contested claims; the sentence check; sources; earlier versions; follow-up questions. An answer that needs new data offers an incremental re-run for it. |
| `#/p/{id}/evidence` | 證據台 (`screens/EvidenceDesk.tsx`) | Tabs 主張 / 衝突 / 主題地圖 / 來源 and a search box. 主張 is a sortable table filtered by status, sub-question, source type and year, exportable as CSV; selecting a row shows the claim's neighbourhood (publishers and entities), its quotes and a link to its finding. 需要你判斷 lists contested claims and claims superseded by newer evidence. Selection, tab and search are in the URL (`?claim=…&tab=…&q=…`). |
| `#/library` | 專案庫 (`screens/Library.tsx`) | All projects by status (全部 / 進行中 / 草稿 / 已完成 / 需要更新 / 已停止或失敗). Completed reports older than 30 days are marked and offer 增量重跑; drafts continue planning; stopped or failed projects can be re-researched; anything not running can be archived (the cleanup steps show inline). |

`#/p/{id}` opens the view that fits the project's status. The top bar has 新研究, 證據台 (the open
project's) and 專案庫; the project header has the tabs 進度 / 報告 / 證據台.

Evidence strength is always a bar glyph plus a word, never colour alone (`components/Bars.tsx`): two blue
bars = 已證實 (two or more independent publishers), blue and orange = 有爭議 (a contradicting quote), one
hollow bar = 單一來源, struck through = 已被取代 (replaced by newer evidence in an incremental run).

## Mock mode (default, no AWS)

```bash
npm install
npm run dev          # http://localhost:5173
```

`public/config.json` ships with `"mode": "mock"`. In this mode the whole backend runs in the browser
(`src/lib/mock.ts`) and emits the same event objects as the contracts:

- **Seeded projects.** A completed report (台灣半導體產業導入生成式 AI 的現況, with round-2 findings, a
  report, a contested claim and the sentence check), a completed report from August (older than 30 days,
  so the library suggests a re-run) and a draft with a proposed plan.
- **Plan review.** 產生計畫 creates a draft and sends `plan.proposed` after about 1.4 s (three
  sub-questions at 快速 depth, five otherwise). A question that contains 「失敗」 sends `plan.failed`
  instead, so the error path is visible. The plan, findings and report are canned content about one
  topic (generative AI in Taiwan's semiconductor industry), whatever question you type.
- **The run.** 開始研究 researches the approved plan (the mock maps your sub-questions onto its canned
  content, at most five): `agent.activity` for every step, `agent.heartbeat` every 2 s, one recovered
  `agent.stalled`, `source.added` for every page (one syndicated copy), claims with the backend's status
  rules, `coverage.updated` after each review, two round-2 questions, a streamed report
  (`synthesis.delta`), `verifying`, `synthesis.ready` and `project.completed`. About 19 s at 1×.
- **Steering.** 改方向 adds a round-2 sub-question for your text and marks the steer applied;
  「停止並用目前結果寫報告」 skips the remaining questions and writes the report; 停止 stops without one.
- **Follow-up questions.** Answers cite the report's claims; a question about something the claims do
  not cover (for example one that asks to add a comparison) comes back with `needsResearch`.
- **Incremental re-runs.** Version 2 re-asks every sub-question for newer data, supersedes one claim
  (`claims.updated`), adds any extra questions, and writes a report with a 本次更新 section; version 1
  moves to 較早的版本.
- The project tools (`project_list`, `project_get`, `project_restart`, `project_cleanup`,
  `project_save`, `project_stop`, `project_steer`, `project_notify`) answer from memory.

The 1×/2× toggle sets the playback speed. Everything the mock produces is labelled 模擬.

Other scripts:

```bash
npm run build        # tsc --noEmit && vite build  -> dist/
npm test             # vitest run
npm run preview      # serve dist/ on :4173
```

## Live mode, running locally

1. Fill in `public/config.json` and set `"mode": "live"`:

   ```json
   {
     "mode": "live",
     "region": "us-west-2",
     "userPoolId": "us-west-2_XXXXXXXXX",
     "userPoolClientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
     "eventsHttpEndpoint": "https://<id>.appsync-api.us-west-2.amazonaws.com/event",
     "agentsBaseUrl": "",
     "toolsMcpUrl": "/mcp"
   }
   ```

   If you leave `agentsBaseUrl` empty and set `toolsMcpUrl` to `/mcp`, the browser sends requests to the
   dev server, which proxies them to the gateways. This avoids CORS during local development.

2. Start the dev server with the gateway origins (scheme and host only, no path):

   ```bash
   VITE_AGENTS_GW_ORIGIN=https://<agents-gateway-host> \
   VITE_TOOLS_GW_ORIGIN=https://<tools-gateway-host> \
   npm run dev
   ```

   - `VITE_AGENTS_GW_ORIGIN` proxies `/research/*` (the app POSTs to `/research/invocations`).
   - `VITE_TOOLS_GW_ORIGIN` proxies `/mcp` (MCP JSON-RPC to the tools gateway).

   Both proxies use `changeOrigin: true, secure: true`. If your tools gateway serves MCP on a different
   path, set `toolsMcpUrl` to that path and proxy it the same way, or use a full URL that allows CORS.
   You can also put these variables in `.env.local`. `vite preview` uses the same proxy settings.

3. Sign in with the Amplify `<Authenticator>`, using a user from the configured Cognito user pool.

How live mode talks to the backend (`src/lib/live.ts`):

- **Events:** `events.connect('/research/' + projectId)` from `aws-amplify/data`, with Cognito
  user-pool auth. The app subscribes before it invokes research.
- **Research runtime:** `POST {agentsBaseUrl}/research/invocations` with `Authorization: Bearer <access token>`
  and `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`. The body is `{ action, projectId, … }` with
  `action` one of `plan` (topic + brief), `start` (topic + brief + the approved `plan`, or
  `mode: 'incremental'` + `extraQuestions`), `ask` (`qaId`, `question`, `selection`) and `stop`.
- **Tools:** MCP over HTTP to `toolsMcpUrl`, in this order: `initialize`, then
  `notifications/initialized`, then `tools/call` with tool names like `project-tools___project_list`.
  The client keeps the `Mcp-Session-Id` header and reads both JSON and SSE responses.

## Events on screen

| event | shown as |
| --- | --- |
| `plan.proposed` / `plan.failed` | The plan panel of 新研究與計畫 fills in, or shows why there is no plan with 再試一次. |
| `project.started` | The run screen starts its step count; an incremental run (`mode: 'incremental'`) moves the current report to 較早的版本. |
| `agent.activity` | A status line under each researching sub-question and card (「搜尋：…」, 「閱讀：example.com/…」, 「寫入 finding」…) and a row in the activity timeline; the supervisor's step sits above the findings. |
| `agent.heartbeat` | Refreshes the liveness indicator (「Agent 運作中 · n 秒前更新」). |
| `agent.stalled` | 「停滯 n 秒，重新嘗試中」 or 「停滯，已放棄」 in the warning colour until the agent's next activity. |
| `plan.ready` (`round: 2`, `steerIds`) | New sub-questions with a 補充研究 chip; a steer listed in `steerIds` becomes 「第 n 輪已套用」. |
| `steer.received` | The steer appears under 改方向 (等待套用) and in the timeline. |
| `finding.ready`, `ui.ready`, `ui.failed`, `relation.added` | Cards, sub-UIs, the coverage rail and the 主題地圖. |
| `source.added` | Counters on the run screen and the 來源 lists (once per `docId`). |
| `coverage.updated` | The coverage squares and the 涵蓋率 list. |
| `claims.updated` | The replaced claims show as 已被取代 (kept, struck through) everywhere. |
| `synthesis.delta` / `synthesis.ready` | The report streams in order of `seq`, then the final report with citations, the sentence check, contradictions, gaps and follow-up suggestions. |
| `qa.ready` / `qa.failed` | The answer under 追問這份報告, or the error with the question kept. |
| `project.completed` / `project.stopped` / `project.failed` | The status pill, a banner on the run screen and the library. |

The report is rendered by a small in-house renderer (`src/lib/markdown.ts`). It supports `##` and `###`
headings, paragraphs, `-` and `1.` lists, `**bold**`, `` `code` ``, links and `[C#]` claim citations (one
claim per bracket, as the backend writes them; a citation and the punctuation after it never wrap apart).
A link is rendered only if
it uses http or https, and it opens with `rel="noopener noreferrer"`. Everything else, including raw
HTML, is shown as text.

**Liveness rule.** `liveness(state, now)` in `src/state.ts` returns one of these values. The project
header re-renders it every second.

- `idle`: no project is running.
- `alive`: the last sign of life was less than 15 s ago (「Agent 運作中 · n 秒前更新」).
- `quiet`: the last sign of life was 15–30 s ago (「已 n 秒沒有回應」).
- `stale`: more than 30 s have passed (「超過 30 秒沒有心跳，agent 可能已停止」). A 「重新整理狀態」 button
  calls `project_get` and restores the project from the result.

The last sign of life is the latest of these:

- the last `agent.heartbeat`
- the start of a run started in this tab
- the project's `updatedAt`
- before the first heartbeat only, the moment this tab loaded the project

A running project that loads with an `updatedAt` more than 3 minutes old is `stale` at once. All times
in the state are epoch milliseconds.

## config.json fields

The app fetches `public/config.json` at startup, so you can change it in a deployed `dist/` without
rebuilding.

| field | used in | meaning |
| --- | --- | --- |
| `mode` | both | `"mock"` runs fully in the browser; `"live"` uses Cognito, AppSync Events and the gateways. |
| `region` | live | AWS region of the user pool and Events API. |
| `userPoolId` | live | Cognito user pool id (required). |
| `userPoolClientId` | live | Cognito app client id, public and without a secret (required). |
| `eventsHttpEndpoint` | live | AppSync Events HTTP endpoint, `https://…/event` (required). |
| `agentsBaseUrl` | live | Base URL of the agents gateway. The app calls `{agentsBaseUrl}/research/invocations`. Leave it empty to use the same origin, such as the dev proxy. |
| `toolsMcpUrl` | live | MCP endpoint of the tools gateway. The default `/mcp` goes through the dev proxy. |
| `emailNotifications` | live | `true` when the deployment can send the end-of-run email (`notifyFromEmail`); the web stack writes it. Without it the email option is hidden. Mock mode always offers it. |

If live mode is selected but a required field is empty, the app shows a configuration message instead of
the console.

## Layout

```
public/config.json        runtime config
src/App.tsx               boot (config, Amplify, <Authenticator>), the workspace: transport, subscriptions,
                          route-driven project loading, actions, top bar
src/router.ts             hash routes: parseRoute, projectPath, navigate, useRoute
src/workspace.ts          Actions and ScreenProps: what every screen gets
src/screens/              Compose (新研究與計畫), Run (研究進行中), Report (報告閱讀器),
                          EvidenceDesk (證據台), Library (專案庫)
src/components/           ProjectHeader (status, steps, stop, tabs), Bars (evidence strength), Evidence (claims,
                          quotes), Sources, SpecRenderer, Graph, Activity, Markdown, useNow
src/types.ts              Project, Finding, Claim, SourceDoc, Coverage, Steer, QA, ResearchEvent (union) …
src/state.ts              pure reducer reduce(state, event), hydrate(projectGetResult), UI actions, liveness(),
                          claimIndex(), claimsOf() / currentClaims()
src/lib/progress.ts       「第 n 步，共 m 步，約剩 x 分鐘」
src/lib/transport.ts      Transport interface (subscribe, invoke, callTool)
src/lib/live.ts           Amplify + agents gateway + MCP tools gateway
src/lib/mock.ts           in-browser backend (+ mockData.ts)
src/lib/mcp.ts            MCP JSON-RPC client (JSON and SSE bodies)
src/lib/spec.ts           spec whitelist validation and "$.a.b" path resolution
src/lib/events.ts         defensive event parsing (object, JSON string, Amplify envelope)
src/lib/activity.ts       activity text, URL shortening, "n 秒前"
src/lib/markdown.ts       safe markdown subset for the report (AST, no HTML), [C#] citations
src/lib/evidence.ts       claim labels, strength, quote links with text fragments, dates
src/styles.css            design tokens (light and dark) and all styles
```

Tests: `state.test.ts` and `progress.test.ts` (reducer, live progress, liveness), `workflow.test.ts`
(routes, step counting, plan review, steering, Q&A, incremental runs, and the same flow through the
mock backend), `contract.test.ts` (replays the backend's fixtures from `../contracts/fixtures/`),
`lib/*.test.ts`.

## Mock mode vs. the real backend

Mock F5 is a `list` finding that deliberately goes through sub-UI generation and fails spec
validation, so the failure path is visible in a demo. The real backend never designs a sub-UI for
`list` or `other` findings (see `contracts/events.md`); those keep the generic card.

Mock claims quote their own key point as the page text, and the verification counts are fixed numbers.
The real backend quotes the stored page text and computes the counts from the sentence check.
