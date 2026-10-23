import { memo } from 'react';
import { COVERAGE_LABEL } from '../lib/evidence';
import { coverageCounts } from '../state';
import type { Coverage, CoverageStatus, Requirement } from '../types';

interface Props {
  requirements: readonly Requirement[];
  coverage: Coverage | null;
  running: boolean;
}

/** The plan's requirements as a checklist; the supervisor's review marks each covered, weak or missing. */
function CoverageListImpl({ requirements, coverage, running }: Props) {
  const byId = new Map((coverage?.requirements ?? []).map((c) => [c.id, c]));
  // Requirements the review reports but the plan did not list (older runs) still show, by id.
  const rows: Requirement[] = [...requirements, ...(coverage?.requirements ?? []).filter((c) => !requirements.some((r) => r.id === c.id)).map((c) => ({ id: c.id, text: c.id }))];
  if (!rows.length) return null;
  const n = coverage ? coverageCounts(coverage.requirements) : null;
  return (
    <div className="cov">
      <div className="cov-hd">
        <h3 className="cov-h">需求涵蓋</h3>
        <span className="cov-sum">
          {n && coverage
            ? `已涵蓋 ${n.covered}/${rows.length}` + (coverage.round > 1 ? ` · 第 ${coverage.round} 輪檢查` : '')
            : running
              ? '子題完成後，supervisor 會逐項檢查'
              : '沒有涵蓋檢查'}
        </span>
      </div>
      <ol className="cov-list">
        {rows.map((r) => {
          const c = byId.get(r.id);
          const status: CoverageStatus | 'pending' = c ? c.status : 'pending';
          return (
            <li key={r.id} className={'cov-i ' + status}>
              <span className="cov-m" aria-hidden="true" />
              <span className="cov-t">{r.text}</span>
              <span className="cov-s">
                {COVERAGE_LABEL[status]}
                {c && c.claimIds.length ? ` · ${c.claimIds.length} 個主張` : ''}
              </span>
              {c?.note ? <span className="cov-note">{c.note}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export const CoverageList = memo(CoverageListImpl);
