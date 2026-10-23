import { memo, useState } from 'react';
import { shortUrl } from '../lib/activity';
import { safeHref } from '../lib/markdown';
import { sourceTypeLabel } from '../state';
import type { SourceDoc } from '../types';

interface Props {
  docs: readonly SourceDoc[];
  /** How many to show before 「顯示全部」. */
  preview?: number;
}

/** Every page the agents read, best sources first, with type, date and duplicate marks. */
function SourceListImpl({ docs, preview = 8 }: Props) {
  const PREVIEW = preview;
  const [all, setAll] = useState(false);
  if (!docs.length) return <p className="src-empty">Sub-agent 讀過的網頁會列在這裡。</p>;
  const sorted = docs
    .map((d, i) => [d, i] as const)
    .sort((a, b) => Number(!!a[0].duplicateOf) - Number(!!b[0].duplicateOf) || (b[0].score ?? 0) - (a[0].score ?? 0) || a[1] - b[1])
    .map(([d]) => d);
  const types = new Map<string, number>();
  for (const d of docs) types.set(d.sourceType ?? 'unknown', (types.get(d.sourceType ?? 'unknown') ?? 0) + 1);
  const typeList = [...types.entries()].sort((a, b) => b[1] - a[1]);
  const publishers = new Set(docs.map((d) => d.publisher).filter(Boolean)).size;
  const dups = docs.filter((d) => d.duplicateOf).length;
  const shown = all ? sorted : sorted.slice(0, PREVIEW);
  const titleOf = new Map(docs.map((d) => [d.docId, d.title]));

  return (
    <div className="srcp">
      <p className="muted small">
        {docs.length} 個來源 · {publishers} 個發布者{dups ? ` · ${dups} 篇轉載` : ''}
      </p>
      <div className="src-types">
        {typeList.map(([t, n]) => (
          <span key={t} className={'chip ' + (['government', 'standards', 'academic', 'official'].includes(t) ? '' : 'neutral')}>
            {sourceTypeLabel(t)} {n}
          </span>
        ))}
      </div>
      <ol className="src-list">
        {shown.map((d) => {
          const href = safeHref(d.url);
          const score = typeof d.score === 'number' ? d.score : null;
          return (
            <li key={d.docId} className={'src-i' + (d.duplicateOf ? ' dup' : '')}>
              <span className="src-t">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {d.title || shortUrl(d.url)}
                  </a>
                ) : (
                  d.title || d.url
                )}
              </span>
              <span className="src-m">
                <span>{d.publisher || shortUrl(d.url, 32)}</span>
                <span>{sourceTypeLabel(d.sourceType)}</span>
                {d.publishedDate ? <span>{d.publishedDate}</span> : null}
                {score !== null ? (
                  <span className="score" title="來源品質分數（類型、時效）">
                    <i style={{ ['--w' as string]: Math.round(score * 100) + '%' }} />
                    {score.toFixed(2)}
                  </span>
                ) : null}
              </span>
              {d.duplicateOf ? <span className="src-dup">轉載自「{titleOf.get(d.duplicateOf) ?? d.duplicateOf}」，不算獨立來源</span> : null}
            </li>
          );
        })}
      </ol>
      {sorted.length > PREVIEW ? (
        <button type="button" className="btn small" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? '只看前 ' + PREVIEW + ' 個' : `顯示全部 ${sorted.length} 個`}
        </button>
      ) : null}
    </div>
  );
}

export const SourceList = memo(SourceListImpl);
