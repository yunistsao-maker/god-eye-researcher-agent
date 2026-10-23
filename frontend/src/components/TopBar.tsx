interface Props {
  mode: 'mock' | 'live';
  topic: string;
  onTopic: (v: string) => void;
  topicLocked: boolean;
  running: boolean;
  canRestart: boolean;
  canSave: boolean;
  saving: boolean;
  speed: number;
  onSpeed: (v: number) => void;
  onStart: () => void;
  onRestart: () => void;
  onSave: () => void;
  user?: string;
  onSignOut?: () => void;
}

export function TopBar(p: Props) {
  return (
    <header className="bar">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <circle cx="13" cy="13" r="11.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          <circle cx="13" cy="13" r="6" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          <circle cx="13" cy="13" r="2.4" fill="var(--live)" />
        </svg>
        <h1>God Eye Researcher</h1>
      </div>
      <div className="topic">
        {p.mode === 'live' ? (
          <label className="label" htmlFor="topic-input">
            研究主題
          </label>
        ) : (
          <span className="label">研究主題</span>
        )}
        <div className="topic-line">
          {p.mode === 'live' ? (
            <input
              id="topic-input"
              className="topic-input"
              type="text"
              value={p.topic}
              maxLength={300}
              disabled={p.topicLocked}
              onChange={(e) => p.onTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !p.running && p.topic.trim()) p.onStart();
              }}
            />
          ) : (
            <>
              <strong>{p.topic}</strong>
              <span className="chip mock">模擬資料，非真實研究結果</span>
            </>
          )}
        </div>
      </div>
      <div className="controls">
        <button className="btn primary" type="button" onClick={p.onStart} disabled={p.running || !p.topic.trim()}>
          開始新研究
        </button>
        <button className="btn" type="button" title="建立新專案，帶入目前專案的 findings 摘要當 seed" onClick={p.onRestart} disabled={p.running || !p.canRestart}>
          重新研究
        </button>
        <button className="btn" type="button" onClick={p.onSave} disabled={p.running || !p.canSave || p.saving}>
          {p.saving ? '儲存中…' : '儲存到 S3'}
        </button>
        {p.mode === 'mock' ? (
          <div className="seg" role="group" aria-label="播放速度">
            {[1, 2].map((v) => (
              <button key={v} type="button" aria-pressed={p.speed === v} disabled={p.running} onClick={() => p.onSpeed(v)}>
                {v}×
              </button>
            ))}
          </div>
        ) : null}
        {p.onSignOut ? (
          <>
            {p.user ? (
              <span className="user" title={p.user}>
                {p.user}
              </span>
            ) : null}
            <button className="btn small" type="button" onClick={p.onSignOut}>
              登出
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}
