# God Eye Researcher: frontend

React research console. Agents research a topic in parallel, and the results stream into the UI as AppSync
events (see `../contracts/events.md`). Each finding first shows as a generic card. When its sub-UI spec
arrives, the card swaps to one of four whitelisted components: `Compare`, `Timeline`, `MetricBars` or
`KeyPoints`. If you are hovering over the card or have focus inside it, the swap waits and a swap bar
appears instead.

Stack: Vite 5.4, React 18.3, TypeScript 5.6 (strict), aws-amplify 6, @aws-amplify/ui-react 6, plain CSS.
There are no UI or graph libraries; the relationship graph is a small force simulation drawn in SVG.

## Mock mode (default, no AWS)

```bash
npm install
npm run dev          # http://localhost:5173
```

`public/config.json` ships with `"mode": "mock"`. In this mode the whole backend runs in the browser
(`src/lib/mock.ts`):

- It emits the same event objects as the contracts, on the prototype's timing: the plan at about 1s, then
  five findings between about 2.6s and 6.5s.
- It simulates sub-UI generation, hits the template cache when a dataShape repeats, and sends one
  `ui.failed`.
- It sends live progress: `agent.activity` for every step (planning, searching with Chinese and English
  queries, reading example.com / example.org pages, writing, designing, done), `agent.heartbeat` every 2 s,
  and one `agent.stalled` (`retrying`) for one sub-agent, which then recovers. In a fresh run this is F4.
- It simulates the evidence backbone: the plan carries five requirements, every page read is a
  `source.added` (one of them a syndicated copy, marked `duplicateOf`), and every finding carries claims
  built from its key points with the backend's status rules (two publishers = corroborated, a
  contradicting quote = contested; F3 has one).
- After round 1 the supervisor reviews (`coverage.updated`, round 1), adds two follow-up questions
  (`plan.ready` again with `round: 2`), and when those are done sends the final coverage, streams a
  simulated report that cites claims as `[C#]` (`synthesis.delta`, about 40 characters every 120 ms),
  shows `verifying`, then `synthesis.ready` with `citations` and `verification`, and
  `project.completed`. A full run takes about 19 s at 1×.
- It answers the project tools (`project_list`, `project_get`, `project_restart`, `project_cleanup`,
  `project_save`) from memory, starting with two seeded projects. The seeded semiconductor project
  includes the round-2 findings and a `synthesis`, so the page opens with a report.

The 1×/2× toggle sets the playback speed.

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
- **Research:** `POST {agentsBaseUrl}/research/invocations` with `Authorization: Bearer <access token>`
  and `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`. The body is
  `{ action: 'start', projectId, topic, parentProjectId }`.
- **Tools:** MCP over HTTP to `toolsMcpUrl`, in this order: `initialize`, then
  `notifications/initialized`, then `tools/call` with tool names like `project-tools___project_list`.
  The client keeps the `Mcp-Session-Id` header and reads both JSON and SSE responses.

## Live progress and the report

The research runtime publishes events that are not persisted (see `../contracts/events.md`). The UI
uses them as follows:

| event | shown as |
| --- | --- |
| `agent.activity` | A one-line status under each researching plan row and card, such as 「搜尋：…」, 「閱讀：example.com/…」, 「思考中…」, 「寫入 finding」 or 「設計 sub-UI」, plus how long ago. The supervisor's step appears at the top of 研究計畫. Its `waiting` phase reads 「等待 sub-agent 完成」, or the event's detail, and shows no idle time. |
| `agent.heartbeat` | Refreshes each listed agent's idle time and the run's liveness. |
| `agent.stalled` | 「停滯 n 秒，重新嘗試中」 or 「停滯，已放棄」 in the warning colour. The agent's next `agent.activity` clears it. |
| `plan.ready` (`round: 2`) | New questions are added as new rows and cards with a 「補充研究」 chip. Existing cards stay as they are. |
| `synthesis.delta` | The 綜合報告 section renders the markdown as it streams, with a caret at the end. Chunks are applied in `seq` order: out-of-order chunks wait in a buffer and duplicates are dropped. |
| `synthesis.ready` | Replaces the streamed text with the final report and lists 矛盾, 缺口 and 後續問題. `project_get` restores it through `synthesis`. |
| `source.added` | Adds the page to the 來源 panel (once per `docId`). |
| `coverage.updated` | Updates the 需求涵蓋 checklist under 研究計畫. |

The event log records searches, reads, supervisor steps, stalls and the first report chunk. It does not
record every thinking step, heartbeat or chunk.

### Evidence

| where | shows |
| --- | --- |
| Finding card | 查證過的主張 replaces the key points when the finding has `claims`. Each claim has a status mark (solid = 已佐證, half orange = 有爭議, hollow = 單一來源) and a label, never colour alone; expanding it lists the quotes with stance, publisher, source type and a 轉載 mark for duplicates. Quote links add a text fragment (`#:~:text=`), so browsers that support it scroll to and highlight the quote on the page. Under a sub-UI the claims are folded behind a summary line. |
| 研究計畫 | 需求涵蓋: every requirement with 已涵蓋 / 證據薄弱 / 尚無資料 (or 待檢查 before the first review), the number of claims and the supervisor's note. |
| 綜合報告 | A 逐句查核 line (cited sentences, supported, partly supported, revised, removed, uncited, citation precision before → after, dead links). `[C#]` markers are chips coloured by the claim's status; clicking one opens a panel with the claim and its quotes, sticky at the bottom of the report so it stays in view, with a button to scroll to the finding card. While the report streams, citations show as plain markers until `synthesis.ready` brings the citation map. |
| 來源 | Sources, publishers and syndicated copies, counts by source type, then every page sorted by score (duplicates last) with publisher, type, date and score. |
| Status bar | 來源 n · 主張 n（已佐證 n）. |

Findings without claims (older projects, the legacy backend) render exactly as before.

The report is rendered by a small in-house renderer (`src/lib/markdown.ts`). It supports `##` and `###`
headings, paragraphs, `-` and `1.` lists, `**bold**`, `` `code` ``, links and `[C#]` claim citations (one
claim per bracket, as the backend writes them; a citation and the punctuation after it never wrap apart).
A link is rendered only if
it uses http or https, and it opens with `rel="noopener noreferrer"`. Everything else, including raw
HTML, is shown as text.

**Liveness rule.** `liveness(state, now)` in `src/state.ts` returns one of these values. The status bar
re-renders it every second.

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

If live mode is selected but a required field is empty, the app shows a configuration message instead of
the console.

## Layout

```
public/config.json      runtime config
src/types.ts            Finding, Claim, SourceDoc, Coverage, Entity, Edge, UiSpec, Project, ResearchEvent (discriminated union)
src/state.ts            pure reducer reduce(state, event), hydrate(projectGetResult), UI actions, liveness(), claimIndex()
src/lib/transport.ts    Transport interface
src/lib/live.ts         Amplify + agents gateway + MCP tools gateway
src/lib/mock.ts         in-browser simulation (+ mockData.ts)
src/lib/mcp.ts          MCP JSON-RPC client (JSON and SSE bodies)
src/lib/spec.ts         spec whitelist validation and "$.a.b" path resolution
src/lib/events.ts       defensive event parsing (object, JSON string, Amplify envelope)
src/lib/activity.ts     activity text (「搜尋：…」), URL shortening, "n 秒前"
src/lib/markdown.ts     safe markdown subset for the report (parses to an AST, no HTML), [C#] citations
src/lib/evidence.ts     claim labels and order, quote links with text fragments
src/components/         TopBar, PlanList, FindingCard, SpecRenderer, Graph, EventLog, Projects, TemplateList,
                        Activity (activity line, supervisor line, liveness indicator), Synthesis, Markdown, useNow,
                        Evidence (claim list, quotes), Coverage (requirement checklist), Sources (source panel)
src/styles.css          design tokens (light and dark) and styles ported from the prototype
```

## Mock mode vs. the real backend

Mock F5 is a `list` finding that deliberately goes through sub-UI generation and fails spec
validation, so the failure path is visible in a demo. The real backend never designs a sub-UI for
`list` or `other` findings (see `contracts/events.md`); those keep the generic card.

Mock claims quote their own key point as the page text, and the verification counts are fixed numbers.
The real backend quotes the stored page text and computes the counts from the sentence check.
