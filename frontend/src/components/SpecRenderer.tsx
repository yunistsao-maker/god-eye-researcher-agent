/*
 * Renders a UiSpec with the host's whitelisted components only (Compare, Timeline, MetricBars, KeyPoints).
 * Data comes from the finding through "$.a.b" paths. Anything else renders nothing; the card then
 * shows the failed state (see FindingCard).
 */
import type { Finding, UiSpec } from '../types';
import { resolvePath, specProblem } from '../lib/spec';

const STAGE_CLASS: Record<string, string> = { 正式上線: 'k-live', 擴大試行: 'k-scale', 試行: 'k-pilot', POC: '' };

function text(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function Compare({ spec, finding }: { spec: Extract<UiSpec['root'], { component: 'Compare' }>; finding: Finding }) {
  const cols = resolvePath(spec.props.columns, finding) as unknown[];
  const rows = resolvePath(spec.props.rows, finding) as unknown[][];
  const emph = spec.props.emphasizeColumn;
  return (
    <div className="cmp-wrap">
      <table className="cmp">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th scope="col" key={i}>
                {text(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => {
                const v = text(c);
                if (ci !== emph) return <td key={ci}>{v}</td>;
                const stage = STAGE_CLASS[v];
                return stage !== undefined ? (
                  <td key={ci}>
                    <span className={'stage' + (stage ? ' ' + stage : '')}>{v}</span>
                  </td>
                ) : (
                  <td key={ci} className="emph">
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({ spec, finding }: { spec: Extract<UiSpec['root'], { component: 'Timeline' }>; finding: Finding }) {
  const items = resolvePath(spec.props.items, finding) as Record<string, unknown>[];
  return (
    <ol className="tl">
      {items.map((it, i) => (
        <li key={i}>
          <span className="when">{text(it[spec.props.label])}</span>
          <span className="rail" aria-hidden="true" />
          <span className="what">{text(it[spec.props.text])}</span>
        </li>
      ))}
    </ol>
  );
}

function MetricBars({ spec, finding, title }: { spec: Extract<UiSpec['root'], { component: 'MetricBars' }>; finding: Finding; title?: string }) {
  const items = resolvePath(spec.props.items, finding) as Record<string, unknown>[];
  const unitField = spec.props.unit;
  const rows = items.map((it) => ({
    label: text(it[spec.props.label]),
    value: Number(it[spec.props.value]),
    unit: unitField ? text(it[unitField]) : '',
  }));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const units = new Set(rows.map((r) => r.unit).filter(Boolean));
  const sharedUnit = units.size === 1 ? [...units][0] : '';
  return (
    <div>
      {title || sharedUnit ? (
        <div className="mb-hd">
          {title ?? ''}
          {sharedUnit ? <span>單位：{sharedUnit}</span> : null}
        </div>
      ) : null}
      <ul className="mb">
        {rows.map((r, i) => (
          <li key={i}>
            <span className="lb">{r.label}</span>
            <span className="tr" aria-hidden="true">
              <span className="fl" style={{ width: ((Math.abs(r.value) / max) * 100).toFixed(1) + '%' }} />
            </span>
            <span className="v">
              {r.value < 0 ? '−' : r.value > 0 ? '+' : ''}
              {Math.abs(r.value)}
              {r.unit}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KeyPoints({ spec, finding }: { spec: Extract<UiSpec['root'], { component: 'KeyPoints' }>; finding: Finding }) {
  const items = resolvePath(spec.props.items, finding) as unknown[];
  return (
    <ul className="kp sub">
      {items.map((k, i) => (
        <li key={i}>{text(k)}</li>
      ))}
    </ul>
  );
}

export function SpecRenderer({ spec, finding }: { spec: unknown; finding: Finding }) {
  if (specProblem(spec, finding)) return null;
  const s = spec as UiSpec;
  const root = s.root;
  const heading = s.title && root.component !== 'MetricBars' ? <p className="sub-title">{s.title}</p> : null;
  let body: JSX.Element | null = null;
  switch (root.component) {
    case 'Compare':
      body = <Compare spec={root} finding={finding} />;
      break;
    case 'Timeline':
      body = <Timeline spec={root} finding={finding} />;
      break;
    case 'MetricBars':
      body = <MetricBars spec={root} finding={finding} title={s.title} />;
      break;
    case 'KeyPoints':
      body = <KeyPoints spec={root} finding={finding} />;
      break;
    default:
      return null;
  }
  return (
    <>
      {heading}
      {body}
    </>
  );
}
