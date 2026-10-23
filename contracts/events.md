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
| `project.created` | `{ "topic", "parentProjectId": string\|null }` | `project_save` (status `running`, first call) |
| `plan.ready` | `{ "subQuestions": [{ "findingId", "question", "dataShape", "round"? }], "requirements"?: [Requirement] }` — always the full plan; a follow-up round re-sends it with the new items appended (`round: 2`). `requirements` is sent when the plan has them; a later `plan.ready` without them keeps the earlier list | `plan_save` |
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

A quote that is not found in the stored page text is dropped; a claim with no quote left is dropped,
and `finding_write` rejects the finding when fewer than half of its claims survive.

`Requirement` = `{ "id": "q1", "text" }` — what a complete answer must cover (at most 12, from the plan).
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
| `project-tools` | `project_save` | `projectId`, `status` (`running`\|`completed`\|`failed`), `topic`?, `parentProjectId`?, `message`? | `{ project }` |
| `project-tools` | `project_stop` | `projectId` | `{ project, stopped: boolean, runtimeSessionId: string\|null }` — `stopped` is `true` only for the call that stopped it |
| `project-tools` | `project_list` | — | `{ projects: [Project] }` |
| `project-tools` | `project_get` | `projectId` | `{ project, plan, requirements, findings, uiSpecs, entities, edges, docs, coverage, synthesis }` (`synthesis` and `coverage` are `null` until written; `docs` lists readable documents only) |
| `project-tools` | `project_restart` | `parentProjectId` | `{ projectId, parentProjectId, topic }` |
| `project-tools` | `project_cleanup` | `projectId` | `{ projectId, status: "archiving", executionArn }`; a `running` project must be stopped first |
| `data-tools` | `plan_save` | `projectId`, `subQuestions` (1–12, each may carry `round` 1–4), `requirements`? (≤ 12 `{ id, text }`) | `{ ok }` |
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
sub-questions, no follow-up round, ~450-word report), `standard` (3–5, one follow-up round, ~800 words)
or `deep` (4–7, two follow-up rounds, ~1 500 words). `startDate` (`YYYY-MM-DD`) and the domain lists
steer searches; `audience` and `notes` shape the plan and the report.

Returns at once with `{ "projectId", "status": "accepted" }`; progress arrives as AppSync events.
Subscribe to `/research/{projectId}` **before** invoking so `project.created` is not missed.

Run order: plan with requirements (round 1) → sub-agents in parallel (each page read is a
`source.added`; each finding carries verified claims) → review: coverage of every requirement
(`coverage.updated`), contradictions, gaps and follow-up questions aimed at weak or missing
requirements → follow-up rounds as the depth allows (`plan.ready` again, `round: 2`…) → report
citing claims as `[C#]`, streamed as `synthesis.delta` → `verifying` (sentence-level check, revision,
link check) → `synthesis.ready` → `project.completed`.

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
