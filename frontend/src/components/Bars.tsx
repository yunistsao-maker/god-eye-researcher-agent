import { STRENGTH_LABEL, type Strength, type StrengthSummary } from '../lib/evidence';
import type { ClaimStatus } from '../types';

interface Props {
  strength: Strength | ClaimStatus;
  /** Supporting publishers (bars), 1–4 shown. */
  support?: number;
  /** Contradicting publishers (rust bars). */
  against?: number;
  size?: 'sm' | 'md' | 'lg';
  /** Spoken label; defaults to the strength's name. */
  label?: string;
}

/**
 * The evidence mark: one bar per independent source (up to four). Solid index blue = verified,
 * blue + rust = contested, one slate outline = a single source. A label always goes with it, for
 * screen readers here and for sighted readers next to it, so colour never carries meaning alone.
 */
export function Bars({ strength, support = 1, against = 0, size = 'sm', label }: Props) {
  const name = label ?? (strength === 'superseded' ? '已被取代' : STRENGTH_LABEL[strength as Strength] ?? '');
  let bars: string[];
  if (strength === 'contested') {
    const a = Math.max(1, Math.min(2, against));
    const s = Math.max(1, Math.min(4 - a, support));
    bars = [...Array(s).fill(''), ...Array(a).fill('c')];
  } else if (strength === 'corroborated') {
    bars = Array(Math.max(2, Math.min(4, support))).fill('');
  } else if (strength === 'none') {
    bars = ['o'];
  } else {
    bars = ['t'];
  }
  const cls = 'bars' + (size === 'sm' ? '' : ' ' + size);
  if (label === '') {
    return (
      <span className={cls} aria-hidden="true">
        {bars.map((k, i) => (
          <i key={i} className={k} />
        ))}
      </span>
    );
  }
  return (
    <span className={cls} role="img" aria-label={name}>
      {bars.map((k, i) => (
        <i key={i} className={k} />
      ))}
    </span>
  );
}

export function BarsFor({ s, size = 'sm' }: { s: StrengthSummary; size?: 'sm' | 'md' | 'lg' }) {
  return <Bars strength={s.strength} support={s.support} against={s.against} size={size} />;
}

/** The three marks explained, as in the report header. */
export function MarkLegend() {
  return (
    <ul className="marks" aria-label="證據標記說明">
      <li>
        <Bars strength="corroborated" support={1} size="md" label="" />
        已證實：至少 2 個獨立來源
      </li>
      <li>
        <Bars strength="contested" support={1} against={1} size="md" label="" />
        有爭議：有反對證據
      </li>
      <li>
        <Bars strength="asserted" size="md" label="" />
        單一來源
      </li>
    </ul>
  );
}
