import '@aws-amplify/ui-react/styles.css';
import './styles.css';
import { Authenticator } from '@aws-amplify/ui-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { ProjectHeader } from './components/ProjectHeader';
import { loadConfig, missingLiveFields } from './config';
import { newProjectId, randomHex } from './lib/ids';
import { configureAmplify, LiveTransport } from './lib/live';
import { MockTransport } from './lib/mock';
import type { Transport } from './lib/transport';
import { navigate, projectPath, useRoute, type ProjectView, type Route } from './router';
import { Compose } from './screens/Compose';
import { EvidenceDesk } from './screens/EvidenceDesk';
import { Library } from './screens/Library';
import { Report } from './screens/Report';
import { Run } from './screens/Run';
import { initialState, update, type LogKind, type ResearchState } from './state';
import type { AppConfig, Brief, Project, ProjectGetResult, ProjectListResult, ResearchEvent, Steer } from './types';
import type { Actions, PlanDraft } from './workspace';

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

/** The view a project opens in when the link does not say. */
function defaultView(state: ResearchState): ProjectView {
  const p = state.project;
  if (!p) return 'run';
  if (p.status === 'draft') return 'plan';
  if (p.status === 'completed' && state.synthesis.status === 'ready') return 'report';
  return 'run';
}

function briefArgs(brief: Brief): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(brief)) if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
}

const Logo = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="9.5" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="11" cy="11" r="4" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="11" cy="11" r="1.4" fill="currentColor" />
  </svg>
);

interface WorkspaceProps {
  config: AppConfig;
  user?: string;
  onSignOut?: () => void;
}

function Workspace({ config, user, onSignOut }: WorkspaceProps) {
  const [state, dispatch] = useReducer(update, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const route = useRoute();
  // A new screen starts at the top; changing a view's parameters (selected claim, tab) does not scroll.
  const screenKey = route.name === 'project' ? `p/${route.id}/${route.view ?? ''}` : route.name;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screenKey]);

  const [speed, setSpeedState] = useState(1);
  const speedRef = useRef(1);
  const setSpeed = (v: number) => {
    speedRef.current = v;
    setSpeedState(v);
  };
  const [busy, setBusy] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState(false);
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

  const onEvent = useCallback((ev: ResearchEvent) => dispatch({ kind: 'event', event: ev, at: Date.now() }), []);
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

  const openId = state.project?.projectId ?? null;
  useEffect(() => {
    if (!openId && mainSub.current) void setMainSub(null);
  }, [openId, setMainSub]);

  /* ---------- projects ---------- */

  const refreshProjects = useCallback(async () => {
    try {
      const res = (await transport.callTool('project_list', {})) as ProjectListResult;
      dispatch({ kind: 'projects.set', projects: sortNewest(Array.isArray(res?.projects) ? res.projects : []) });
    } catch (err) {
      log('note', '讀取專案失敗：' + errText(err));
      showToast(<>讀取專案失敗：{errText(err)}</>);
    } finally {
      setLoadingProjects(false);
    }
  }, [transport, log, showToast]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  /** Restore a project from project_get and listen to its channel. */
  const openProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (stateRef.current.project?.projectId === projectId) return true;
      setOpening(projectId);
      setOpenError(null);
      try {
        const got = (await transport.callTool('project_get', { projectId })) as ProjectGetResult;
        dispatch({ kind: 'hydrate', result: got, at: Date.now() });
        await setMainSub(projectId).catch((err) => log('note', '訂閱失敗：' + errText(err)));
        return true;
      } catch (err) {
        setOpenError(errText(err));
        return false;
      } finally {
        setOpening(null);
      }
    },
    [transport, setMainSub, log],
  );

  // Routes decide what is open.
  useEffect(() => {
    if (route.name === 'home') {
      if (loadingProjects) return;
      navigate(stateRef.current.projects.some((p) => p.status !== 'archived') ? '#/library' : '#/new', true);
    } else if (route.name === 'project' && state.project?.projectId !== route.id && opening !== route.id && !openError) {
      void openProject(route.id);
    } else if (route.name === 'library') {
      void refreshProjects();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, loadingProjects]);
  useEffect(() => setOpenError(null), [route]);

  // A project link without a view goes to the one that fits its status.
  useEffect(() => {
    if (route.name === 'project' && !route.view && state.project?.projectId === route.id) navigate(projectPath(route.id, defaultView(state)), true);
  }, [route, state]);

  /* ---------- actions ---------- */

  const run = useCallback(
    async (what: string, fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        log('note', `${what}失敗：` + errText(err));
        showToast(
          <>
            {what}失敗：{errText(err)}
          </>,
        );
      } finally {
        setBusy(false);
      }
    },
    [log, showToast],
  );

  const scale = () => (config.mode === 'mock' ? speedRef.current : 1);

  const actions: Actions = {
    proposePlan: (topic, brief, parentProjectId = null) =>
      run('產生計畫', async () => {
        const open = stateRef.current.project;
        const reuse = open?.status === 'draft' && route.name === 'project' && route.id === open.projectId;
        const projectId = reuse ? open.projectId : newProjectId();
        if (reuse) dispatch({ kind: 'planning.redo', at: Date.now() });
        else dispatch({ kind: 'planning.start', projectId, topic, parentProjectId, at: Date.now(), brief });
        await setMainSub(projectId);
        if (!reuse) navigate(projectPath(projectId, 'plan'));
        await transport.invoke('plan', { projectId, topic, parentProjectId, ...briefArgs(brief) });
      }),
    saveProposal: (plan: PlanDraft) =>
      run('儲存計畫', async () => {
        const p = stateRef.current.project;
        if (!p || p.status !== 'draft') return;
        const subQuestions = plan.subQuestions.map((q, i) => ({ findingId: `f-${i + 1}`, question: q.question, dataShape: q.dataShape }));
        await transport.callTool('data-tools___plan_propose', { projectId: p.projectId, subQuestions, requirements: plan.requirements, brief: plan.brief, by: 'user' });
        dispatch({ kind: 'project.patch', projectId: p.projectId, patch: { brief: plan.brief, topic: plan.topic } });
        showToast(<>計畫已儲存，可以從專案庫繼續。</>);
      }),
    startPlan: (plan: PlanDraft) =>
      run('開始研究', async () => {
        const open = stateRef.current.project;
        const draft = open?.status === 'draft' ? open : null;
        const projectId = draft?.projectId ?? newProjectId();
        if (draft) dispatch({ kind: 'run.begin', projectId, at: Date.now(), scale: scale() });
        else dispatch({ kind: 'run.start', projectId, topic: plan.topic, parentProjectId: null, at: Date.now(), scale: scale() });
        await setMainSub(projectId);
        navigate(projectPath(projectId, 'run'));
        await transport.invoke('start', {
          projectId,
          topic: plan.topic,
          parentProjectId: draft?.parentProjectId ?? null,
          plan: { subQuestions: plan.subQuestions, requirements: plan.requirements.map((r) => r.text) },
          ...briefArgs(plan.brief),
        });
      }),
    startDirect: (topic, brief, parentProjectId = null) =>
      run('開始研究', async () => {
        const open = stateRef.current.project;
        const draft = open?.status === 'draft' && route.name === 'project' ? open : null;
        const projectId = draft?.projectId ?? newProjectId();
        if (draft) dispatch({ kind: 'run.begin', projectId, at: Date.now(), scale: scale() });
        else dispatch({ kind: 'run.start', projectId, topic, parentProjectId, at: Date.now(), scale: scale() });
        await setMainSub(projectId);
        navigate(projectPath(projectId, 'run'));
        await transport.invoke('start', { projectId, topic, parentProjectId: draft?.parentProjectId ?? parentProjectId, ...briefArgs(brief) });
      }),
    stop: () =>
      run('停止研究', async () => {
        const p = stateRef.current.project;
        if (!p) return;
        const res = (await transport.callTool('project_stop', { projectId: p.projectId })) as { runtimeSessionId?: string | null };
        try {
          await transport.invoke('stop', { projectId: p.projectId }, res?.runtimeSessionId ?? undefined);
        } catch (err) {
          log('note', '通知 runtime 停止失敗，它會在 15 秒內自行停下：' + errText(err));
        }
        showToast(<>研究已停止，已完成的部分都保留。</>);
      }),
    finishEarly: () =>
      run('收尾', async () => {
        const p = stateRef.current.project;
        if (!p) return;
        const res = (await transport.callTool('project_steer', { projectId: p.projectId, kind: 'finish' })) as { steer?: Steer };
        if (res?.steer) dispatch({ kind: 'steer.local', steer: res.steer, at: Date.now() });
        showToast(<>會略過還沒開始的子題，用目前的結果寫報告。</>);
      }),
    redirect: async (text) => {
      const p = stateRef.current.project;
      if (!p) return false;
      let ok = false;
      await run('改方向', async () => {
        const res = (await transport.callTool('project_steer', { projectId: p.projectId, kind: 'redirect', text })) as { steer?: Steer };
        if (res?.steer) dispatch({ kind: 'steer.local', steer: res.steer, at: Date.now() });
        ok = true;
      });
      return ok;
    },
    setNotify: (enabled) =>
      run('設定通知', async () => {
        const p = stateRef.current.project;
        if (!p) return;
        const res = (await transport.callTool('project_notify', { projectId: p.projectId, enabled })) as { notify?: boolean; available?: boolean };
        dispatch({ kind: 'project.patch', projectId: p.projectId, patch: { notify: !!res?.notify } });
        if (enabled && res?.available === false) showToast(<>這個部署沒有設定寄件者，無法寄送 email 通知。</>);
      }),
    ask: (question, selection) =>
      run('追問', async () => {
        const p = stateRef.current.project;
        if (!p) return;
        const qaId = 'qa-' + randomHex(10);
        dispatch({ kind: 'qa.ask', qaId, question, selection, at: Date.now() });
        try {
          await transport.invoke('ask', { projectId: p.projectId, qaId, question, ...(selection ? { selection } : {}) });
        } catch (err) {
          dispatch({ kind: 'qa.error', qaId, message: errText(err) });
          throw err;
        }
      }),
    rerun: (extraQuestions = [], projectId) =>
      run('增量重跑', async () => {
        const id = projectId ?? stateRef.current.project?.projectId;
        if (!id) return;
        if (!(await openProject(id))) throw new Error('無法開啟專案');
        const p = stateRef.current.project!;
        if (p.status !== 'completed') throw new Error('只有已完成的專案可以增量重跑');
        dispatch({ kind: 'run.begin', projectId: id, at: Date.now(), scale: scale() });
        navigate(projectPath(id, 'run'));
        await transport.invoke('start', { projectId: id, topic: p.topic, mode: 'incremental', ...(extraQuestions.length ? { extraQuestions } : {}) });
      }),
    refreshStatus: async () => {
      const p = stateRef.current.project;
      if (!p) return;
      setRefreshing(true);
      try {
        const got = (await transport.callTool('project_get', { projectId: p.projectId })) as ProjectGetResult;
        if (stateRef.current.project?.projectId !== p.projectId) return;
        dispatch({ kind: 'hydrate', result: got, at: Date.now() });
      } catch (err) {
        showToast(<>重新整理失敗：{errText(err)}</>);
      } finally {
        setRefreshing(false);
      }
    },
    refreshProjects,
    askCleanup: (projectId) => dispatch({ kind: 'cleanup.confirm', projectId }),
    cancelCleanup: (projectId) => dispatch({ kind: 'cleanup.cancel', projectId }),
    confirmCleanup: (projectId) => confirmCleanup(projectId),
    highlight: (entityId) => dispatch({ kind: 'highlight', entityId }),
    toast: showToast,
  };

  /* ---------- cleanup (archive) ---------- */

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
        await acquire(projectId, 'cleanup');
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
          dispatch({ kind: 'cleanup.error', projectId, message: '2 分鐘內沒有確認封存完成，請稍後重新整理' });
          return;
        }
        if (inFlight) return;
        inFlight = true;
        try {
          const res = (await transport.callTool('project_list', {})) as ProjectListResult;
          if (!(res?.projects ?? []).some((p) => p.projectId === projectId && p.status !== 'archived')) dispatch({ kind: 'cleanup.archived', projectId });
        } finally {
          inFlight = false;
        }
      }, LIVE_POLL_MS);
      pollers.current.set(projectId, h);
    },
    [acquire, release, transport, config.mode, log, stopPoll],
  );

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
        showToast(<>已封存專案，報告與來源快照留在 S3 封存檔。</>);
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

  /* ---------- render ---------- */

  const p = state.project;
  const projectRoute = route.name === 'project' ? route : null;
  const ready = !!projectRoute && p?.projectId === projectRoute.id;
  const view: ProjectView | null = ready ? projectRoute!.view ?? defaultView(state) : null;
  const props = { state, config, actions, busy };

  let body: ReactNode;
  if (route.name === 'new') body = <Compose key={'new:' + (route.from ?? '')} {...props} fresh from={route.from} />;
  else if (route.name === 'library' || route.name === 'home') body = <Library {...props} loading={loadingProjects} />;
  else if (!ready) {
    body = (
      <main className="page narrow" id="main">
        {openError ? (
          <div className="panel pad stack">
            <h1 className="sec-h">打不開這個專案</h1>
            <p className="err">{openError}</p>
            <a className="btn" href="#/library">
              回專案庫
            </a>
          </div>
        ) : (
          <p className="empty">讀取專案…</p>
        )}
      </main>
    );
  } else if (view === 'plan' && p!.status === 'draft') body = <Compose key={p!.projectId} {...props} />;
  else {
    const v = view === 'plan' ? 'run' : view!;
    body = (
      <>
        <ProjectHeader state={state} actions={actions} view={v} busy={busy} refreshing={refreshing} />
        {v === 'run' ? <Run {...props} /> : v === 'report' ? <Report {...props} /> : <EvidenceDesk {...props} params={projectRoute!.params} />}
      </>
    );
  }

  const navCurrent = (r: Route, name: 'new' | 'evidence' | 'library') =>
    name === 'new' ? r.name === 'new' || (r.name === 'project' && r.view === 'plan') : name === 'evidence' ? r.name === 'project' && r.view === 'evidence' : r.name === 'library';
  const evidenceHref = p && p.status !== 'draft' ? projectPath(p.projectId, 'evidence') : null;

  return (
    <>
      <a className="sr-only" href="#main">
        跳到主要內容
      </a>
      <header className="topnav">
        <a className="brand" href="#/library">
          <Logo />
          God Eye
        </a>
        <nav className="nav" aria-label="主要">
          <a href="#/new" aria-current={navCurrent(route, 'new') ? 'page' : undefined}>
            新研究
          </a>
          {evidenceHref ? (
            <a href={evidenceHref} aria-current={navCurrent(route, 'evidence') ? 'page' : undefined}>
              證據台
            </a>
          ) : (
            <a className="disabled" aria-disabled="true" title="先開啟一個專案">
              證據台
            </a>
          )}
          <a href="#/library" aria-current={navCurrent(route, 'library') ? 'page' : undefined}>
            專案庫
          </a>
        </nav>
        <span className="spacer" />
        {config.mode === 'mock' ? (
          <>
            <span className="mock-badge">模擬資料，非真實研究結果</span>
            <div className="seg" role="group" aria-label="播放速度">
              {[1, 2].map((v) => (
                <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)}>
                  {v}×
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className="user-menu">
          <button type="button" className="avatar" aria-label={'帳號' + (user ? '：' + user : '')} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            {(user ?? 'E').slice(0, 1).toUpperCase()}
          </button>
          {menu ? (
            <div className="menu" role="menu">
              <p>{user ?? (config.mode === 'mock' ? '模擬模式' : '已登入')}</p>
              {onSignOut ? (
                <button type="button" role="menuitem" onClick={onSignOut}>
                  登出
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      {body}
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </>
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
        if (cfg.mode === 'live') {
          const missing = missingLiveFields(cfg);
          if (missing.length) {
            setError('config.json 缺少 live 模式需要的欄位：' + missing.join('、'));
            return;
          }
          configureAmplify(cfg);
        }
        setConfig(cfg);
      })
      .catch((err) => alive && setError('讀不到 config.json：' + errText(err)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Boot title="設定有誤">
        <p>{error}</p>
      </Boot>
    );
  }
  if (!config) return <Boot title="God Eye Researcher">載入中…</Boot>;
  if (config.mode === 'mock') return <Workspace config={config} />;
  return (
    <Authenticator hideSignUp>
      {({ signOut, user }) => <Workspace config={config} user={user?.signInDetails?.loginId ?? user?.username} onSignOut={signOut} />}
    </Authenticator>
  );
}
