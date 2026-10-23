import '@aws-amplify/ui-react/styles.css';
import './styles.css';
import { Authenticator } from '@aws-amplify/ui-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { loadConfig, missingLiveFields } from './config';
import { newProjectId } from './lib/ids';
import { configureAmplify, LiveTransport } from './lib/live';
import { MockTransport } from './lib/mock';
import type { Transport } from './lib/transport';
import { claimIndex, evidenceStats, findingLabel, hydrate, initialState, statsOf, update, type LogKind } from './state';
import type { AppConfig, Project, ProjectGetResult, ProjectListResult, ProjectRestartResult, ResearchEvent } from './types';
import { DEFAULT_TOPIC } from './types';
import { LivenessIndicator, SupervisorLine } from './components/Activity';
import { CoverageList } from './components/Coverage';
import { EventLog } from './components/EventLog';
import { FindingCard } from './components/FindingCard';
import { Graph, GraphLegend } from './components/Graph';
import { PlanList } from './components/PlanList';
import { Projects } from './components/Projects';
import { SourceList } from './components/Sources';
import { SynthesisView } from './components/Synthesis';
import { TemplateList } from './components/TemplateList';
import { TopBar } from './components/TopBar';
import { prefersReducedMotion } from './components/usePrefersReducedMotion';

const CLEANUP_STEP_MS = 420;
const LIVE_POLL_MS = 3000;
const LIVE_POLL_LIMIT_MS = 120_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sortNewest(list: Project[]): Project[] {
  const key = (p: Project) => p.createdAt ?? p.updatedAt ?? '';
  return [...list].sort((a, b) => key(b).localeCompare(key(a)) || b.projectId.localeCompare(a.projectId));
}

function Elapsed({ running, startedAt, scale, final }: { running: boolean; startedAt: number | null; scale: number; final: number | undefined }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(h);
  }, [running]);
  const v = running && startedAt != null ? ((Date.now() - startedAt) * scale) / 1000 : final;
  return <b>{v == null ? '—' : v.toFixed(1) + 's'}</b>;
}

interface ConsoleProps {
  config: AppConfig;
  user?: string;
  onSignOut?: () => void;
}

function Console({ config, user, onSignOut }: ConsoleProps) {
  const [state, dispatch] = useReducer(update, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [speed, setSpeedState] = useState(1);
  const speedRef = useRef(1);
  const setSpeed = (v: number) => {
    speedRef.current = v;
    setSpeedState(v);
  };
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [toast, setToast] = useState<ReactNode | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const showToast = useCallback((node: ReactNode) => {
    setToast(node);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const log = useCallback((kind: LogKind, text: string) => dispatch({ kind: 'log', logKind: kind, text, at: Date.now() }), []);

  const transport: Transport = useMemo(
    () => (config.mode === 'live' ? new LiveTransport(config, log) : new MockTransport({ log, getSpeed: () => speedRef.current })),
    [config, log],
  );
  useEffect(() => () => transport.dispose?.(), [transport]);

  /* ---------- events & subscriptions ---------- */

  const onEvent = useCallback((ev: ResearchEvent) => {
    let busy: string[] | undefined;
    if (ev.type === 'ui.ready') {
      const el = document.getElementById('card-' + ev.data.findingId);
      if (el && (el.matches(':hover') || el.contains(document.activeElement))) busy = [ev.data.findingId];
    }
    dispatch({ kind: 'event', event: ev, at: Date.now(), busy });
  }, []);

  const subs = useRef(new Map<string, { users: Set<string>; ready: Promise<() => void> }>());

  const acquire = useCallback(
    async (projectId: string, userKey: string) => {
      let entry = subs.current.get(projectId);
      if (!entry) {
        const ready = transport.subscribe(projectId, onEvent);
        entry = { users: new Set(), ready };
        subs.current.set(projectId, entry);
        ready.catch(() => {
          if (subs.current.get(projectId) === entry) subs.current.delete(projectId);
        });
      }
      entry.users.add(userKey);
      await entry.ready;
    },
    [transport, onEvent],
  );

  const release = useCallback((projectId: string, userKey: string) => {
    const entry = subs.current.get(projectId);
    if (!entry) return;
    entry.users.delete(userKey);
    if (entry.users.size) return;
    subs.current.delete(projectId);
    entry.ready.then((unsub) => unsub()).catch(() => undefined);
  }, []);

  const mainSub = useRef<string | null>(null);
  const setMainSub = useCallback(
    async (projectId: string | null) => {
      if (mainSub.current === projectId) return;
      if (mainSub.current) release(mainSub.current, 'main');
      mainSub.current = projectId;
      if (projectId) await acquire(projectId, 'main');
    },
    [acquire, release],
  );

  // Drop the main subscription when the open project goes away (e.g. it was cleaned up).
  const openId = state.project?.projectId ?? null;
  useEffect(() => {
    if (!openId && mainSub.current) void setMainSub(null);
  }, [openId, setMainSub]);

  /* ---------- initial load: project_list, then restore the newest ---------- */

  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        const res = (await transport.callTool('project_list', {})) as ProjectListResult;
        const projects = sortNewest(Array.isArray(res?.projects) ? res.projects : []);
        dispatch({ kind: 'projects.set', projects });
        const newest = projects.find((p) => p.status !== 'archived' && p.status !== 'archiving');
        if (!newest) return;
        const got = (await transport.callTool('project_get', { projectId: newest.projectId })) as ProjectGetResult;
        if (stateRef.current.project) return; // a new run started meanwhile
        dispatch({ kind: 'hydrate', result: got, at: Date.now() });
        const h = hydrate(got);
        const ui = Object.values(h.slots).filter((s) => s.ui.status === 'ready').length;
        log('note', `從 S3 還原 ${newest.projectId}：findings/×${h.order.filter((id) => h.slots[id].finding).length}、ui/×${ui}（存在專案內，不依賴模板快取）`);
        await setMainSub(newest.projectId).catch((err) => log('note', '訂閱失敗：' + errText(err)));
      } catch (err) {
        log('note', '讀取專案失敗：' + errText(err));
        showToast(<>讀取專案失敗：{errText(err)}</>);
      } finally {
        setLoadingProjects(false);
      }
    })();
  }, [transport, log, showToast, setMainSub]);

  /* ---------- start / restart / save ---------- */

  // Only a run started in this tab locks the controls; a restored "running" project (maybe orphaned) does not.
  const running = starting || (state.project?.status === 'running' && state.clock.running);

  const start = useCallback(
    async (parentProjectId: string | null) => {
      if (starting || stateRef.current.project?.status === 'running') return;
      setStarting(true);
      const mark = stateRef.current.logSeq;
      let projectId = '';
      try {
        let runTopic = topic.trim() || DEFAULT_TOPIC;
        let parent: string | null = null;
        if (parentProjectId) {
          const r = (await transport.callTool('project_restart', { parentProjectId })) as ProjectRestartResult;
          projectId = r.projectId;
          runTopic = r.topic || stateRef.current.project?.topic || runTopic;
          parent = r.parentProjectId ?? parentProjectId;
        } else {
          projectId = newProjectId();
        }
        dispatch({ kind: 'run.start', projectId, topic: runTopic, parentProjectId: parent, at: Date.now(), scale: config.mode === 'mock' ? speedRef.current : 1, keepLogAfter: mark });
        await setMainSub(projectId); // subscribe FIRST so project.created is not missed
        await transport.startResearch({ projectId, topic: runTopic, parentProjectId: parent });
      } catch (err) {
        if (projectId) dispatch({ kind: 'run.error', projectId, message: errText(err), at: Date.now() });
        else log('note', '無法開始研究：' + errText(err));
        showToast(<>無法開始研究：{errText(err)}</>);
      } finally {
        setStarting(false);
      }
    },
    [starting, topic, transport, config.mode, setMainSub, log, showToast],
  );

  const save = useCallback(async () => {
    const p = stateRef.current.project;
    if (!p || p.status !== 'completed') return;
    setSaving(true);
    try {
      await transport.callTool('project_save', { projectId: p.projectId, status: 'completed' });
      showToast(
        <>
          已儲存到 <code>s3://research-bucket/projects/{p.projectId}/</code>
        </>,
      );
    } catch (err) {
      log('note', '儲存失敗：' + errText(err));
      showToast(<>儲存失敗：{errText(err)}</>);
    } finally {
      setSaving(false);
    }
  }, [transport, log, showToast]);

  /* ---------- liveness: re-read the open project when heartbeats stopped ---------- */

  const [refreshing, setRefreshing] = useState(false);
  const refreshStatus = useCallback(async () => {
    const p = stateRef.current.project;
    if (!p) return;
    setRefreshing(true);
    try {
      const got = (await transport.callTool('project_get', { projectId: p.projectId })) as ProjectGetResult;
      if (stateRef.current.project?.projectId !== p.projectId) return; // another project was opened meanwhile
      dispatch({ kind: 'hydrate', result: got, at: Date.now() });
      log('note', `重新讀取 ${p.projectId}：狀態 ${got?.project?.status ?? '未知'}${got?.project?.updatedAt ? '，updatedAt ' + got.project.updatedAt : ''}`);
    } catch (err) {
      log('note', '重新整理狀態失敗：' + errText(err));
      showToast(<>重新整理狀態失敗：{errText(err)}</>);
    } finally {
      setRefreshing(false);
    }
  }, [transport, log, showToast]);

  /* ---------- cleanup ---------- */

  const pollers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const stopPoll = useCallback((id: string) => {
    const h = pollers.current.get(id);
    if (h) clearInterval(h);
    pollers.current.delete(id);
  }, []);

  const confirmCleanup = useCallback(
    async (projectId: string) => {
      dispatch({ kind: 'cleanup.start', projectId });
      try {
        await acquire(projectId, 'cleanup'); // project.archived arrives on the project's channel
      } catch (err) {
        log('note', '訂閱失敗：' + errText(err));
      }
      try {
        await transport.callTool('project_cleanup', { projectId });
      } catch (err) {
        release(projectId, 'cleanup');
        dispatch({ kind: 'cleanup.error', projectId, message: errText(err) });
        return;
      }
      if (config.mode !== 'live') return;
      const startedAt = Date.now();
      let inFlight = false;
      const h = setInterval(async () => {
        const c = stateRef.current.cleanup[projectId];
        if (!c || c.phase !== 'running') return stopPoll(projectId);
        if (Date.now() - startedAt > LIVE_POLL_LIMIT_MS) {
          stopPoll(projectId);
          release(projectId, 'cleanup');
          dispatch({ kind: 'cleanup.error', projectId, message: '2 分鐘內沒有確認封存完成，請稍後重新整理專案清單' });
          return;
        }
        if (inFlight) return;
        inFlight = true;
        try {
          const res = (await transport.callTool('project_list', {})) as ProjectListResult;
          const still = (res?.projects ?? []).some((p) => p.projectId === projectId && p.status !== 'archived');
          if (!still) dispatch({ kind: 'cleanup.archived', projectId });
        } catch (err) {
          log('note', 'project_list 輪詢失敗：' + errText(err));
        } finally {
          inFlight = false;
        }
      }, LIVE_POLL_MS);
      pollers.current.set(projectId, h);
    },
    [acquire, release, transport, config.mode, log, stopPoll],
  );

  // Step animation while any cleanup is running (holds on the last step until confirmed).
  const runningCleanups = Object.entries(state.cleanup)
    .filter(([, c]) => c.phase === 'running')
    .map(([id]) => id)
    .join(',');
  useEffect(() => {
    if (!runningCleanups) return;
    const ids = runningCleanups.split(',');
    const h = setInterval(() => ids.forEach((projectId) => dispatch({ kind: 'cleanup.step', projectId })), CLEANUP_STEP_MS / speedRef.current);
    return () => clearInterval(h);
  }, [runningCleanups]);

  // Confirmed: show every step done for a beat, then drop the project and tell the user.
  const removing = useRef(new Set<string>());
  useEffect(() => {
    for (const [projectId, c] of Object.entries(state.cleanup)) {
      if (c.phase !== 'done' || removing.current.has(projectId)) continue;
      removing.current.add(projectId);
      stopPoll(projectId);
      setTimeout(() => {
        removing.current.delete(projectId);
        dispatch({ kind: 'cleanup.remove', projectId });
        release(projectId, 'cleanup');
        showToast(
          <>
            已清理 <code>{projectId}</code>：S3 物件交給 Lifecycle 處理，DynamoDB 設定 TTL，向量已刪除。
          </>,
        );
      }, CLEANUP_STEP_MS / speedRef.current);
    }
  }, [state.cleanup, release, showToast, stopPoll]);

  useEffect(
    () => () => {
      pollers.current.forEach(clearInterval);
      pollers.current.clear();
    },
    [],
  );

  /* ---------- interaction ---------- */

  const onEntity = useCallback((entityId: string) => dispatch({ kind: 'highlight', entityId }), []);
  const onToggleView = useCallback((findingId: string) => dispatch({ kind: 'view.toggle', findingId }), []);
  const onApplySwap = useCallback((findingId: string) => {
    dispatch({ kind: 'swap.apply', findingId });
    // The swap bar unmounts; keep keyboard focus on the card.
    requestAnimationFrame(() => document.getElementById('card-' + findingId)?.focus({ preventScroll: true }));
  }, []);
  const onGraphFinding = useCallback((findingId: string) => {
    const el = document.getElementById('card-' + findingId);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }, []);
  const clearTemplates = useCallback(() => {
    if (transport instanceof MockTransport) transport.clearTemplates();
    dispatch({ kind: 'templates.clear' });
    log('note', '模板快取已清空，下次研究會重新生成 sub-UI');
  }, [transport, log]);

  /* ---------- render ---------- */

  const p = state.project;
  const st = statsOf(state);
  const pillCls = !p ? 'idle' : p.status === 'running' ? 'running' : p.status === 'failed' ? 'failed' : 'completed';
  const pillText = !p ? '沒有開啟中的專案' : p.status === 'running' ? '研究中' : p.status === 'failed' ? '失敗' : '已完成';
  const hlEntity = state.highlight ? state.entities[state.highlight]?.name ?? state.nodes[state.highlight]?.label ?? state.highlight : null;
  const questions = useMemo(() => Object.fromEntries(state.order.map((id) => [id, state.slots[id]?.question ?? ''])), [state.order, state.slots]);
  const claims = useMemo(() => claimIndex(state), [state.order, state.slots]);
  const ev = useMemo(() => evidenceStats(state), [state.order, state.slots, state.docs]);
  const labelOf = useCallback((id: string) => findingLabel(state, id), [state.order]);
  const topicShown = config.mode === 'mock' ? p?.topic || topic : topic;

  return (
    <div className="wrap">
      <TopBar
        mode={config.mode}
        topic={topicShown}
        onTopic={setTopic}
        topicLocked={running}
        running={running}
        canRestart={!!p}
        canSave={p?.status === 'completed'}
        saving={saving}
        speed={speed}
        onSpeed={setSpeed}
        onStart={() => void start(null)}
        onRestart={() => p && void start(p.projectId)}
        onSave={() => void save()}
        user={user}
        onSignOut={onSignOut}
      />

      <div className="status">
        <span className={'pill ' + pillCls}>
          <span className="dot" />
          <span>{pillText}</span>
        </span>
        <LivenessIndicator project={p} live={state.live} refreshing={refreshing} onRefresh={() => void refreshStatus()} />
        <span className="pid-line">
          {p ? p.projectId + (p.parentProjectId ? '  ← parent ' + p.parentProjectId : '') : ''}
          {p && config.mode === 'live' && p.topic && p.topic !== topic ? ' · ' + p.topic : ''}
        </span>
        {p ? (
          <div className="stats">
            <span>
              Findings <b>{st.ready + '/' + st.total}</b> · 來源 <b>{ev.sources}</b> · 主張 <b>{ev.claims}</b>
              {ev.claims ? (
                <>
                  {' '}
                  （已佐證 <b>{ev.corroborated}</b>）
                </>
              ) : null}{' '}
              · 關聯 <b>{st.edges}</b> · sub-UI <b>{st.uiReady}</b> · 耗時{' '}
              <Elapsed running={state.clock.running} startedAt={state.clock.startedAt} scale={state.clock.scale} final={p.stats?.elapsedSec} />
            </span>
          </div>
        ) : null}
        {p?.status === 'failed' && p.message ? <span className="fail-note">{p.message}</span> : null}
      </div>

      <div className="layout">
        <main className="col">
          <section aria-labelledby="h-plan">
            <div className="section-hd">
              <h2 id="h-plan">研究計畫</h2>
              <span className="hint">Supervisor 拆解的子題，各由一個 sub-agent 平行研究</span>
            </div>
            <SupervisorLine agent={state.agents.supervisor} running={p?.status === 'running'} />
            <PlanList hasProject={!!p} plan={state.plan} order={state.order} slots={state.slots} agents={state.agents} />
            {p ? <CoverageList requirements={state.requirements} coverage={state.coverage} running={p.status === 'running'} /> : null}
          </section>
          {p ? (
            <section aria-labelledby="h-report">
              <div className="section-hd">
                <h2 id="h-report">綜合報告</h2>
                <span className="hint">
                  {state.synthesis.status === 'streaming' && p.status === 'running'
                    ? 'Supervisor 撰寫中，內容逐字出現'
                    : state.synthesis.verification
                      ? '每句引用都對回查證過的主張；點 [C#] 看原文引述'
                      : 'Supervisor 整合各子題，列出矛盾、缺口與後續問題'}
                </span>
              </div>
              <SynthesisView
                key={p.projectId}
                synthesis={state.synthesis}
                running={p.status === 'running'}
                claims={claims}
                findingLabel={labelOf}
                onFinding={onGraphFinding}
              />
            </section>
          ) : null}
          <section aria-labelledby="h-cards">
            <div className="section-hd">
              <h2 id="h-cards">研究結果</h2>
              <span className="hint">先顯示通用卡片，sub-UI 好了再替換；滑鼠停在卡片上時不會自動替換</span>
            </div>
            {!p ? (
              <div className="empty">
                {state.notice === 'archived'
                  ? '專案已封存並清理。按「開始新研究」啟動新的專案，結果會即時串流到這裡。'
                  : loadingProjects
                    ? '讀取已儲存的專案…'
                    : '按「開始新研究」啟動新的專案，結果會即時串流到這裡。'}
              </div>
            ) : (
              <div className="cards">
                {state.order.map((id) => {
                  const slot = state.slots[id];
                  return slot ? (
                    <FindingCard
                      key={id}
                      slot={slot}
                      label={findingLabel(state, id)}
                      agent={state.agents[id]}
                      highlight={state.highlight}
                      onEntity={onEntity}
                      onToggleView={onToggleView}
                      onApplySwap={onApplySwap}
                    />
                  ) : null;
                })}
              </div>
            )}
          </section>
        </main>

        <aside className="col">
          <section className="panel graph" aria-labelledby="h-graph">
            <div className="section-hd">
              <h2 id="h-graph">關聯圖</h2>
              <span className="hint">點節點標示相關卡片</span>
            </div>
            <Graph nodes={state.nodes} edges={state.edges} order={state.order} questions={questions} highlight={state.highlight} onEntity={onEntity} onFinding={onGraphFinding} />
            <GraphLegend edges={state.edges} />
            {hlEntity ? (
              <div className="hl-note">
                <span>
                  標示中：<b>{hlEntity}</b>
                </span>
                <button className="btn small" type="button" onClick={() => dispatch({ kind: 'highlight', entityId: null })}>
                  清除
                </button>
              </div>
            ) : null}
          </section>
          {p ? (
            <section className="panel" aria-labelledby="h-src">
              <div className="section-hd">
                <h2 id="h-src">來源</h2>
                <span className="hint">去重、分類並評分過的網頁</span>
              </div>
              <SourceList docs={state.docs} />
            </section>
          ) : null}
          <section className="panel" aria-labelledby="h-log">
            <div className="section-hd">
              <h2 id="h-log">事件串流</h2>
              <span className="hint mono">{p ? '/research/' + p.projectId : ''}</span>
            </div>
            <EventLog log={state.log} />
          </section>
          <section className="panel" aria-labelledby="h-proj">
            <div className="section-hd">
              <h2 id="h-proj">已儲存專案</h2>
              <span className="hint mono">s3://research-bucket/projects/</span>
            </div>
            <Projects
              projects={state.projects}
              currentId={p?.projectId ?? null}
              running={running}
              cleanup={state.cleanup}
              loading={loadingProjects}
              onAsk={(id) => dispatch({ kind: 'cleanup.confirm', projectId: id })}
              onCancel={(id) => dispatch({ kind: 'cleanup.cancel', projectId: id })}
              onConfirm={(id) => void confirmCleanup(id)}
            />
            <TemplateList templates={state.templates} onClear={config.mode === 'mock' ? clearTemplates : undefined} />
          </section>
        </aside>
      </div>
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function Boot({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="boot">
      <div className="box">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadConfig()
      .then((cfg) => {
        if (!alive) return;
        if (cfg.mode === 'live' && !missingLiveFields(cfg).length) configureAmplify(cfg);
        setConfig(cfg);
      })
      .catch((err) => alive && setError(errText(err)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Boot title="無法載入設定">
        <p>
          讀取 <code>config.json</code> 失敗：{error}
        </p>
      </Boot>
    );
  }
  if (!config) return <div className="boot" aria-busy="true" />;

  if (config.mode === 'live') {
    const missing = missingLiveFields(config);
    if (missing.length) {
      return (
        <Boot title="live 模式設定不完整">
          <p>
            <code>config.json</code> 缺少：<code>{missing.join('、')}</code>。填好後重新整理，或把 <code>mode</code> 改回 <code>mock</code>。
          </p>
        </Boot>
      );
    }
    return (
      <Authenticator>
        {({ signOut, user }) => <Console config={config} user={user?.signInDetails?.loginId ?? user?.username} onSignOut={signOut} />}
      </Authenticator>
    );
  }
  return <Console config={config} />;
}
