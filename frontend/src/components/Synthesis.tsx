import { memo, useCallback, useState } from 'react';
import { CLAIM_STATUS_LABEL, claimMeta, pct } from '../lib/evidence';
import type { ClaimRef, SynthesisState } from '../state';
import type { Verification } from '../types';
import { ClaimGlyph, EvidenceList } from './Evidence';
import { InlineMarkdown, Markdown, type CiteRenderer } from './Markdown';

interface Props {
  synthesis: SynthesisState;
  /** The project is running, so more text may still arrive. */
  running: boolean;
  /** claimId → claim, for resolving [C#] citations. */
  claims: ReadonlyMap<string, ClaimRef>;
  /** "F2" for a finding id. */
  findingLabel: (findingId: string) => string;
  /** Scrolls to a finding card. */
  onFinding: (findingId: string) => void;
}

/** The sentence-level check of the report, as one line of counts. */
function VerificationBar({ v }: { v: Verification }) {
  const dead = v.deadUrls ?? [];
  const items: [string, number, string][] = [
    ['有據', v.supported, 'ok'],
    ['部分有據', v.partial, 'part'],
    ['已修正', v.revised, 'fix'],
    ['已刪除', v.removed, 'del'],
    ['未引用', v.uncitedSentences, 'plain'],
  ];
  return (
    <div className="verify" aria-label="報告查核結果">
      <span className="verify-h">逐句查核</span>
      <span className="verify-i">
        引用句 <b>{v.citedSentences}</b>
      </span>
      {items
        .filter(([, n]) => n > 0)
        .map(([label, n, cls]) => (
          <span key={label} className={'verify-i ' + cls}>
            {label} <b>{n}</b>
          </span>
        ))}
      {v.precisionBefore != null || v.precisionAfter != null ? (
        <span className="verify-i" title="引用句中被所引主張支持的比例：修正前 → 修正後">
          引用精確度 <b>{pct(v.precisionBefore)}</b>
          {v.precisionAfter != null && v.precisionAfter !== v.precisionBefore ? (
            <>
              {' → '}
              <b>{pct(v.precisionAfter)}</b>
            </>
          ) : null}
        </span>
      ) : null}
      {dead.length ? (
        <span className="verify-i del" title={dead.join('\n')}>
          失效連結 <b>{dead.length}</b>
        </span>
      ) : null}
    </div>
  );
}

function SynthesisViewImpl({ synthesis: syn, running, claims, findingLabel, onFinding }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const resolve = useCallback((label: string) => {
    const ref = syn.citations[label];
    return ref ? claims.get(ref.claimId) ?? null : null;
  }, [syn.citations, claims]);
  const cite: CiteRenderer = useCallback(
    (label: string) => {
      const ref = resolve(label);
      if (!ref) return <span className="cite plain">{label}</span>;
      const on = open === label;
      return (
        <button
          type="button"
          className={'cite ' + ref.claim.status + (on ? ' on' : '')}
          aria-expanded={on}
          aria-controls="cite-panel"
          title={`${CLAIM_STATUS_LABEL[ref.claim.status]}：${ref.claim.text}`}
          onClick={() => setOpen(on ? null : label)}
        >
          {label}
        </button>
      );
    },
    [resolve, open],
  );

  if (syn.status === 'none') {
    return <div className="report-empty">{running ? '所有子題完成後，supervisor 會在這裡撰寫綜合報告' : '這個專案沒有綜合報告。'}</div>;
  }
  if (syn.status === 'streaming') {
    return (
      <div className="report" aria-busy={running}>
        {syn.text ? (
          <Markdown source={syn.text} caret={running} />
        ) : (
          <p className="report-wait">
            Supervisor 正在撰寫報告…{running ? <span className="caret" aria-hidden="true" /> : null}
          </p>
        )}
        {!running ? <p className="report-note">報告沒有寫完，這裡是已收到的部分。</p> : null}
      </div>
    );
  }
  const groups = (
    [
      ['矛盾', 'con', syn.contradictions],
      ['缺口', 'gap', syn.gaps],
      ['後續問題', 'fu', syn.followUps],
    ] as const
  ).filter(([, , items]) => items.length > 0);
  const sel = open ? resolve(open) : null;
  return (
    <div className="report">
      {syn.verification ? <VerificationBar v={syn.verification} /> : null}
      <Markdown source={syn.text} cite={cite} />
      {groups.length ? (
        <div className="syn-lists">
          {groups.map(([label, cls, items]) => (
            <div key={cls} className={'syn-g ' + cls}>
              <h3 className="syn-h">
                {label} <span className="n">{items.length}</span>
              </h3>
              <ul>
                {items.map((t, i) => (
                  <li key={i}>
                    <InlineMarkdown text={t} cite={cite} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      {/* Last in the report and sticky, so it stays in view while the reader scrolls the text. */}
      {sel && open ? (
        <div className="cite-panel" id="cite-panel" role="region" aria-label={'引用 ' + open}>
          <div className="cite-hd">
            <span className="cite-l">{open}</span>
            <ClaimGlyph status={sel.claim.status} />
            <span className="claim-s">{CLAIM_STATUS_LABEL[sel.claim.status]}</span>
            <span className="cite-meta">{claimMeta(sel.claim)}</span>
            <button type="button" className="btn small link" onClick={() => onFinding(sel.findingId)}>
              看 {findingLabel(sel.findingId)} 卡片
            </button>
            <button type="button" className="btn small" onClick={() => setOpen(null)} aria-label="關閉引用">
              關閉
            </button>
          </div>
          <p className="cite-t">{sel.claim.text}</p>
          <EvidenceList evidence={sel.claim.evidence} />
        </div>
      ) : null}
    </div>
  );
}

export const SynthesisView = memo(SynthesisViewImpl);
