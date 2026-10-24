# Contracts

Everything in the system is derived from the **finding** JSON. The backend and frontend share
these contracts; change them here first.

## AppSync Events

- Namespace: `research`
- Channel per project: `/research/{projectId}`
- Publish auth: IAM (Lambda tools only). Subscribe auth: Cognito user pool.

Every event is one JSON object:

```json
{ "type": "finding.ready", "projectId": "p-20261022-1a2b3c4d", "ts": "2026-10-22T15:04:05.123Z", "data": { } }
```

| type | data | published by |
| --- | --- | --- |
| `project.created` | `{ "topic", "parentProjectId": string\|null, "status": "draft" \| "running" }` | `project_save` (first call: `draft` for a plan to review, `running` for a direct start) |
| `plan.proposed` | `{ "subQuestions": [{ "findingId", "question", "dataShape" }], "requirements": [Requirement], "brief": Brief, "by": "agent" \| "user" }` — a plan waiting for the user's approval (status `draft`) | `plan_propose` |
| `project.started` | `{ "version", "mode": "full" \| "incremental", "since": "YYYY-MM-DD" \| null }` — a `draft` project was approved, or a `completed` one is re-run | `project_save` (status `running` on an existing project) |
| `plan.ready` | `{ "subQuestions": [SubQuestion], "requirements"?: [Requirement], "steerIds"?: [steerId] }` — always the full plan; a follow-up round re-sends it with the new items appended (`round: 2`). `requirements` is sent when the plan has them; a later `plan.ready` without them keeps the earlier list. `steerIds` names the user's directions this round applies | `plan_save` |
| `steer.received` | `{ "steer": Steer }` — the user redirected a running project or asked it to wrap up | `project_steer` |
| `claims.updated` | `{ "superseded": [{ "claimId", "findingId", "supersededBy" }] }` — an incremental run found newer evidence that replaces these claims | `finding_write` |
| `qa.ready` | `{ "qa": QA }` — an answer to a follow-up question about the report | `qa_write` |
| `finding.ready` | `{ "finding": Finding }` | `finding_write` |
| `relation.added` | `{ "entities": [Entity], "edges": [Edge] }` | `finding_write` |
| `ui.ready` | `{ "findingId", "spec": UiSpec, "cache": boolean }` | `ui_spec_write` / `ui_template_get` caller |
| `ui.failed` | `{ "findingId", "reason" }` | `ui_spec_write` |
| `source.added` | `{ "doc": SourceDoc }` — a page a sub-agent read for the first time in this project | `fetch_page` (with `projectId`) |
| `coverage.updated` | `Coverage` — the supervisor's latest check of every requirement | `coverage_save` |
| `project.completed` | `{ "stats": { "findings", "edges", "uiReady", "elapsedSec", "sources"?, "claims"? } }` | `project_save` (status `completed`) |
| `project.failed` | `{ "message" }` | `project_save` (status `failed`) |
| `project.stopped` | `{ "stats": { "findings", "edges", "uiReady", "elapsedSec" } }` | `project_stop` (the user stopped a running project) |
| `project.archived` | `{}` | cleanup state machine, last step |
| `synthesis.ready` | `{ "synthesis": Synthesis }` | `synthesis_write` |

Published by the research runtime when a request it accepted cannot finish (not persisted):
`plan.failed { "message" }` (the plan could not be drafted) and `qa.failed { "qaId", "message" }`.

### Live progress (published by the research runtime itself)

These are not persisted; they exist so the UI can show what every agent is doing right now and
notice when nothing is happening. The runtime publishes them directly to AppSync (IAM), batched
about every 300 ms, so they may arrive slightly out of order relative to the tool events above.

| type | data | when |
| --- | --- | --- |
| `agent.activity` | `{ "agentId", "phase", "detail"?, "round"? }` | an agent starts a new step (see phases below) |
| `agent.heartbeat` | `{ "elapsedSec", "agents": [{ "agentId", "phase", "idleSec" }] }` | every 10 s while the run is alive |
| `agent.stalled` | `{ "agentId", "idleSec", "action": "retrying" \| "gave_up" }` | the watchdog cancelled an agent that produced nothing for `STALL_SEC` |
| `synthesis.delta` | `{ "seq", "text" }` | the report is being written; append `text` in `seq` order |

`agentId` is `supervisor` or a finding id (`f-1` …). `detail` is at most 200 characters.

| phase | agent | detail |
| --- | --- | --- |
| `planning` | supervisor | — |
| `waiting` | supervisor | e.g. `等待 5 個 sub-agent` (sub-agents are running; not watched for stalls) |
| `thinking` | any | — (the model is generating; reasoning text is not forwarded) |
| `searching` | sub-agent | the search query |
| `reading` | sub-agent | the page URL |
| `writing` | sub-agent | — (`finding_write`) |
| `designing` | sub-agent | — (sub-UI spec) |
| `reviewing` | supervisor | — (looking for contradictions and gaps) |
| `reporting` | supervisor | — (writing the report; `synthesis.delta` follows) |
| `verifying` | supervisor | — (checking every cited sentence against its claims, revising unsupported ones, checking links) |
| `done` / `failed` | any | short reason for `failed` |
| `stopped` | any | — (the user stopped the research; best effort, see "Stopping a run") |

**Liveness rule for clients:** a run is alive while `agent.heartbeat` keeps arriving. If none has
arrived for 30 s while the project is `running`, show that the agent may have stopped. When a page
loads a `running` project, `project.updatedAt` older than 3 minutes means the same (the runtime
refreshes it every 30 s).

`Synthesis` = `{ "report": markdown string, "contradictions": [string], "gaps": [string], "followUps": [string], "createdAt", "citations"?, "verification"? }`.
The report cites claims as `[C1]`, `[C2]` … (one claim per bracket, `[C1][C3]` for several);
`citations` maps each label to `{ "claimId", "findingId" }`. `verification` is the sentence-level
check (see "Evidence" below). Reports written without verified claims have neither.

Report layout (what the reader renders specially; older reports without it still render):

- `# Title` and the paragraph under it: the report's title and its scope line (no citations needed).
- `## 執行摘要` (or `Executive summary`): a bold paragraph that answers the topic, then bullets that start
  with a bold label (`- **現況：** …`).
- Theme sections, each starting with a `**結論：** …` (or `**Bottom line:**`) paragraph.
- Markdown pipe tables (header row and separator row); a row's citations sit in its cells. The sentence
  check treats a row as one unit: an unsupported row is deleted, never rewritten.
- `## 矛盾與不確定性`, `## 建議`, `## 待追蹤事項` (open questions; citations optional). No sources
  section: clients list the sources from `docs`.

`Edge` = `{ "from": nodeId, "to": nodeId, "type": EdgeType, "via"?: entityId }`.
Node ids are finding ids (`f-…`) or entity ids (`e-…`).

| EdgeType | from → to | meaning |
| --- | --- | --- |
| `mentions` | finding → entity | the finding names this entity |
| `shares_entity` | finding → finding | both findings mention `via` |
| `supports` / `contradicts` / `causes` | entity → entity, or finding → finding | explicit relation stated by a sub-agent |
| `similar_to` | finding → finding | embedding similarity (phase 2) |

## Evidence

The backend, not the model, decides what counts as evidence. Every page a sub-agent reads with
`fetch_page` (with `projectId`) becomes a project document; every finding states atomic claims with
verbatim quotes, and `finding_write` checks each quote against the stored page text before it
accepts the claim.

`SourceDoc` = `{ "docId", "url", "canonicalUrl", "title", "publisher", "publishedDate", "sourceType", "score", "duplicateOf", "via", "fetchedAt" }`

| field | meaning |
| --- | --- |
| `docId` | `d-` + 12 hex characters, from the canonical URL (tracking parameters, `www.`, fragments and trailing slashes removed) |
| `publisher` | registrable domain (`stat.gov.tw`, `example.co.uk`); two pages with the same publisher are not independent |
| `publishedDate` | `YYYY-MM-DD` from page metadata, or `null` |
| `sourceType` | `government`, `standards`, `academic`, `research`, `news`, `reference`, `community`, `official` or `unknown`, from the domain |
| `score` | 0.05–1 prior from the source type, minus small penalties for no date, age (> 1 and > 3 years) and plain http; blocked domains score 0.05. It ranks sources; it never decides whether a claim is true |
| `duplicateOf` | `docId` of an earlier page with near-identical text (MinHash similarity ≥ 0.8), such as a syndicated copy; `null` otherwise |
| `via` | `direct` (fetched by us) or the extract provider |

`Claim` (inside `Finding.claims`, written by `finding_write`):

```json
{ "claimId": "c-1-2", "text": "…", "status": "corroborated", "independentSources": 2, "supporting": 2, "contradicting": 0,
  "evidence": [{ "docId", "quote", "stance": "supports", "charStart", "charEnd", "url", "title", "publisher", "duplicateOf", "sourceType", "score" }] }
```

| status | rule |
| --- | --- |
| `corroborated` | quotes from at least two different publishers support it (a duplicate counts as its original's publisher) |
| `asserted` | supported by one publisher only |
| `contested` | at least one quote contradicts it |
| `superseded` | an incremental run found a newer claim that replaces it (`supersededBy`); kept for history, left out of reports |

A claim from an incremental run may carry `updates: claimId` (the claim it replaces).

A quote that is not found in the stored page text is dropped; a claim with no quote left is dropped,
and `finding_write` rejects the finding when fewer than half of its claims survive.

`Requirement` = `{ "id": "q1", "text" }` — what a complete answer must cover (at most 12, from the plan).
`SubQuestion` = `{ "findingId", "question", "dataShape", "round"?, "version"?, "updates"? }` — `round` counts
review rounds within a run, `version` the run (incremental runs), `updates` the earlier sub-question an
incremental one re-researches.
`Coverage` = `{ "round", "requirements": [{ "id", "status": "covered" | "weak" | "missing", "claimIds": [claimId], "note"? }], "updatedAt" }`.

`verification` (in `Synthesis`): `{ "citedSentences", "supported", "partial", "unsupported", "revised",
"removed", "uncitedSentences", "unknownCitations", "claimsCited", "precisionBefore", "precisionAfter",
"deadUrls" }`. Counts are sentences; `precisionBefore` / `precisionAfter` are the share of cited
sentences that their claims support before and after the reviser rewrote or removed the others;
`deadUrls` are cited sources that no longer resolve (`url_check`).

## Finding

See `finding.schema.json`. `claims` (optional) holds the verified claims above; findings written
before the evidence backbone have none. `data` holds the shape-specific payload:

| dataShape | data |
| --- | --- |
| `comparison` | `{ "columns": [string], "rows": [[string]] }` |
| `timeline` | `{ "items": [{ "when": string, "what": string }] }` |
| `metrics` | `{ "items": [{ "label": string, "value": number, "unit": string }] }` |
| `list` / `other` | `{}` (generic card only) |

Only `comparison`, `timeline` and `metrics` findings get a sub-UI. `list` and `other` findings keep
the generic card and no `ui.*` event is sent for them.

## UI spec (sub-UI)

See `ui-spec.schema.json`. A spec is a template: it never contains data, only paths into the
finding (`"$.data.rows"`). The host renders it with its own whitelisted components, so the
same spec works for every finding with the same `dataShape`.

| component | props |
| --- | --- |
| `Compare` | `columns`, `rows` (paths), `emphasizeColumn` (int, optional) |
| `Timeline` | `items` (path), `label`, `text` (field names) |
| `MetricBars` | `items` (path), `label`, `value`, `unit` (field names) |
| `KeyPoints` | `items` (path) |

## Gateway tools (tools gateway, MCP)

Tool names on the wire are `{target}___{tool}`. Every tool on our Lambda targets (`project-tools`,
`data-tools`, `web-tools`) also receives `_caller`, the Cognito `sub` of the user, injected by the
request interceptor from the validated JWT. A value sent by the client is always overwritten.

| target | tool | input | output |
| --- | --- | --- | --- |
| `project-tools` | `project_save` | `projectId`, `status` (`draft`\|`running`\|`completed`\|`failed`), `topic`?, `parentProjectId`?, `brief`?, `reopen`?, `message`?, `runtimeSessionId`? | `{ project, steering }` — `draft` only creates; `running` on a `draft` starts it; `running` with `reopen: true` on a `completed` project starts an incremental run |
| `project-tools` | `project_steer` | `projectId`, `kind` (`redirect`\|`finish`), `text`? | `{ steer }` |
| `project-tools` | `project_notify` | `projectId`, `enabled` | `{ notify, available }` |
| `project-tools` | `project_stop` | `projectId` | `{ project, stopped: boolean, runtimeSessionId: string\|null }` — `stopped` is `true` only for the call that stopped it |
| `project-tools` | `project_list` | — | `{ projects: [Project] }` |
| `project-tools` | `project_get` | `projectId` | `{ project, plan, proposedPlan, requirements, findings, uiSpecs, entities, edges, docs, coverage, synthesis, history, steering, qa }` (`synthesis`, `coverage` and `proposedPlan` are `null` until written; `docs` lists readable documents only) |
| `project-tools` | `project_restart` | `parentProjectId` | `{ projectId, parentProjectId, topic }` |
| `project-tools` | `project_cleanup` | `projectId` | `{ projectId, status: "archiving", executionArn }`; a `running` project must be stopped first |
| `data-tools` | `plan_propose` | `projectId` (a `draft`), `subQuestions` (1–12 `{ findingId, question, dataShape }`), `requirements` (≤ 12 `{ id, text }`), `brief`?, `by`? | `{ ok }` |
| `data-tools` | `plan_save` | `projectId`, `subQuestions` (1–40, each may carry `round` 1–10, `version`, `updates`), `requirements`? (≤ 12 `{ id, text }`), `steerIds`? | `{ ok }` |
| `data-tools` | `qa_write` | `projectId`, `qaId`, `question`, `selection`?, `answer`, `citations`, `needsResearch`, `researchQuestion`? | `{ ok }` |
| `data-tools` | `coverage_save` | `projectId`, `round`? (1–4), `coverage` (`[{ id, status, claimIds, note? }]`) | `{ ok, covered, total }` |
| `data-tools` | `synthesis_write` | `projectId`, `report` (markdown, ≤ 30 000 chars), `contradictions`?, `gaps`?, `followUps`? (each ≤ 10 strings), `citations`?, `verification`? | `{ ok }` |
| `data-tools` | `finding_write` | `projectId`, `finding` (with `claims`?: `[{ text, evidence: [{ docId, quote, stance }] }]`) | `{ ok, findingId, edges, claims, sources, warnings }` or `{ ok: false, errors }` |
| `data-tools` | `ui_template_get` | `dataShape` | `{ hit, spec }` |
| `data-tools` | `ui_spec_write` | `projectId`, `findingId`, `spec`, `fromCache`? | `{ ok }` or `{ ok: false, reason }` |
| `web-search` | `WebSearch` (managed AgentCore Web Search connector) | `query` (≤ 200 chars), `maxResults`? (1–25), `filters`? | `{ id, results: [{ text, url?, title?, publishedDate? }] }` |
| `web-tools` | `fetch_page` | `url`, `maxChars`? (500–20 000), `offset`?, `projectId`? | without `projectId`: `{ url, title, text, … }`; with it: `SourceDoc` fields + `{ text, offset, nextOffset, totalChars, cached }`. A page already in the project is served from its S3 snapshot; robots.txt, private hosts and blocked domains are refused |
| `web-tools` | `search_web` | `query`, `maxResults`?, `includeDomains`?, `excludeDomains`?, `startDate`? | `{ results: [{ title, url, snippet, publishedDate, publisher }] }` — secondary provider (Tavily or Exa) when `searchSecretArn` is configured |
| `web-tools` | `url_check` | `urls` (≤ 20) | `{ results: [{ url, ok, status, finalUrl?, error? }], dead: [url] }` |

`web-search___WebSearch` is not one of our Lambdas: it does not take `_caller`, and the
interceptor strips `_caller` from its arguments. Its terms require showing citations with links
to end users, which the finding cards do (`sources[].url`).

## Research agent (agents gateway, HTTP target `research`)

`POST /research/invocations` with `Authorization: Bearer <Cognito access token>` and
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (33–256 chars).

```json
{ "action": "start", "projectId": "p-20261022-1a2b3c4d", "topic": "…", "parentProjectId": null,
  "depth": "standard", "audience": "…", "startDate": "2024-01-01", "includeDomains": [], "excludeDomains": [], "notes": "…" }
```

Everything after `parentProjectId` is optional (the research brief). `depth` is `quick` (2–3
sub-questions, no follow-up round, ~600-word report), `standard` (3–5, one follow-up round, ~1 100 words)
or `deep` (4–7, two follow-up rounds, ~2 000 words; a Chinese character counts as half a word). `startDate` (`YYYY-MM-DD`) and the domain lists
steer searches; `audience` and `notes` shape the plan and the report.

Returns at once with `{ "projectId", "status": "accepted" }`; progress arrives as AppSync events.
Subscribe to `/research/{projectId}` **before** invoking so `project.created` is not missed.

Run order: plan with requirements (round 1) → sub-agents in parallel (each page read is a
`source.added`; each finding carries verified claims) → review: coverage of every requirement
(`coverage.updated`), contradictions, gaps and follow-up questions aimed at weak or missing
requirements → follow-up rounds as the depth allows (`plan.ready` again, `round: 2`…) → report
citing claims as `[C#]`, streamed as `synthesis.delta` → `verifying` (sentence-level check, revision,
link check) → `synthesis.ready` → `project.completed`.

## Plan review, steering, follow-up questions, incremental runs

The UI's flow is: write the question and the brief → review the proposed plan → watch the run (redirect
it, wrap it up early or stop it) → read the report (ask follow-up questions) → re-run it later for new
data. Every step below works without the others: a client may still send `start` without a plan.

### Statuses and versions

`Project.status` is one of `draft`, `running`, `completed`, `failed`, `stopped`, `archiving`,
`archived`. `draft` holds a proposed plan; it becomes `running` when the user starts it.
`Project` also carries `version` (1 for the first run, +1 for every incremental run), `since`
(the date an incremental run searches from), `completedAt`, `brief`, `notify` and `stats`.

`Brief` = `{ "depth", "audience", "startDate", "includeDomains", "excludeDomains", "notes" }` (the
research brief of `start`, stored with the project).

### Plan review

1. `POST /research/invocations` `{ "action": "plan", "projectId", "topic", …brief }` returns
   `{ status: "accepted" }`. The runtime creates the project as `draft` (`project.created` with
   `status: "draft"`), drafts sub-questions and requirements, and publishes `plan.proposed`
   (`by: "agent"`), or `plan.failed`.
2. The user edits the plan. Saving it calls `data-tools___plan_propose` with the edited lists
   (`by: "user"`); `project_get` returns it as `proposedPlan`.
3. `start` with `"plan": { "subQuestions": [{ "question", "dataShape" }], "requirements": [string] }`
   researches exactly that plan (no planning step). The draft becomes `running`
   (`project.started`, `mode: "full"`).

### Steering a running project

`project-tools___project_steer { projectId, kind: "redirect" | "finish", text? }` stores a
`Steer` = `{ "steerId", "kind", "text", "createdAt" }` and publishes `steer.received`. The runtime
reads new steers with its heartbeat (every 15 s):

- `redirect` (text 3–500 chars): applied at the next review — the supervisor plans follow-up
  sub-questions for it (one extra round is allowed for it even when the depth has no rounds left)
  and the report addresses it. The `plan.ready` of that round lists its `steerId`. Steers that
  arrive after the report has started are not applied.
- `finish`: sub-questions that have not started are skipped, no further rounds run, and the report is
  written from what is finished.

At most 10 steers per run; only a `running` project accepts them.

### Follow-up questions about the report

`POST /research/invocations` `{ "action": "ask", "projectId", "qaId", "question", "selection"? }`
returns `{ status: "accepted" }`. The answer uses only the project's verified claims, cites them as
`[C#]` (the same labels as the report where the report cites them), and is saved with
`data-tools___qa_write`, which publishes `qa.ready`. `project_get` returns all of them as `qa`.

`QA` = `{ "qaId", "question", "selection"?, "answer": markdown, "citations": { "C1": { claimId, findingId } },
"needsResearch": boolean, "researchQuestion"?: string, "createdAt" }`. `needsResearch` means the claims
cannot answer it; `researchQuestion` is what an incremental run should look for.

### Incremental runs

`start` with `"mode": "incremental"` on a `completed` project (optionally `"extraQuestions": [string]`)
re-runs it for newer data: `version` goes up by one and `since` is the date of the previous
completion (`project.started`, `mode: "incremental"`). Each earlier sub-question gets a new
sub-question (`version`, `updates`: the earlier findingId) researched only from pages published on
or after `since`, given the claims already known. A new claim that replaces an earlier one carries
`updates: claimId`; `finding_write` marks the earlier claim `superseded` (`supersededBy`) and
publishes `claims.updated`. The report is rewritten from all current claims with a section on what
changed; the previous report moves to `history` (`[{ "version", "createdAt", "report" }]`) and the new
`Synthesis` carries `version` and `changes: { "newClaims", "updatedClaims" }`.

### Email when a run ends

`project-tools___project_notify { projectId, enabled }` returns `{ notify, available }`. When enabled,
the user gets an email (Amazon SES, from the deployment's `notifyFromEmail`) when the project
completes or fails. `available` is false when the deployment has no sender configured; the web app
reads `emailNotifications` from `config.json` to decide whether to offer it.

## Stopping a run

`Project.status` is one of `running`, `completed`, `failed`, `stopped`, `archiving`, `archived`.
`stopped` is final for that project id (restart it with `project_restart`, which makes a new one).

The client stops a run in two calls; each one works without the other:

1. `project-tools___project_stop { projectId }` — the durable stop. Owner-checked, idempotent.
   A `running` project becomes `stopped` and `project.stopped` is published. From then on the
   project never changes again: `project_save` will not overwrite `stopped`, and `plan_save`,
   `finding_write`, `ui_spec_write` and `synthesis_write` are refused with
   `{ "ok": false, "error": "Project … was stopped", "stopped": true }`.
2. `POST /research/invocations` with `{ "action": "stop", "projectId" }` and
   `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` set to the `runtimeSessionId` that `project_stop`
   returned — the fast stop. The runtime cancels every agent's model call (≈ 2 s), ends the
   research task and then terminates its own AgentCore session (`StopRuntimeSession` with the
   user's bearer token), which also ends any model call still waiting on Bedrock. If the request
   lands in a different session than the run, the runtime terminates the run's session directly.
   Returns `{ "projectId", "status": "stopping" | "terminated" | "not_running" }`.

If step 2 fails, a running runtime still notices step 1 within 30 s (its heartbeat
`project_save` is refused with `stopped: true`) and stops itself the same way.

Clients: once a project is `stopped`, ignore later `agent.*` and `synthesis.delta` events — the
runtime's batched progress may still arrive for a moment. Sub-questions without a finding, sub-UIs
still generating and a report still streaming are settled as stopped (the partial report text may
be kept, marked unfinished). `agent.activity` with phase `stopped` is best effort: the session may be
terminated before it is sent.
