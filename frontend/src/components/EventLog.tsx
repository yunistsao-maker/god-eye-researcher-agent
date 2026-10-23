import { memo, type ReactNode } from 'react';
import type { LogEntry } from '../state';

const KIND_LABEL = { gw: 'GW', ev: 'EV', note: '··' } as const;
const KIND_CLASS = { gw: 'gw', ev: 'ev', note: 'no' } as const;

/** Renders "**bold**" segments as <b>; everything else is plain text (no HTML injection). */
export function richText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : part,
  );
}

function EventLogImpl({ log }: { log: LogEntry[] }) {
  const newest = log[0]?.id;
  return (
    <>
      <div className="legend-log">
        <span className="gw">GW → Gateway 呼叫</span>
        <span className="ev">EV ← AppSync 事件</span>
      </div>
      <ol className="log" aria-live="polite" aria-relevant="additions">
        {log.length === 0 ? <li className="log-empty">還沒有事件。</li> : null}
        {log.map((l) => (
          <li key={l.id} className={l.id === newest ? 'fresh' : ''}>
            <span className="t">{l.t}</span>
            <span className={'k ' + KIND_CLASS[l.kind]}>{KIND_LABEL[l.kind]}</span>
            <span className="m">{richText(l.text)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

export const EventLog = memo(EventLogImpl);
