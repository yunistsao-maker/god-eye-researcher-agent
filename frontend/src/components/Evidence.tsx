import { memo } from 'react';
import { shortUrl } from '../lib/activity';
import { CLAIM_STATUS_LABEL, claimMeta, quoteHref, sortClaims } from '../lib/evidence';
import { sourceTypeLabel } from '../state';
import type { Claim, ClaimStatus, Evidence } from '../types';

/** Solid = corroborated, split = contested, hollow = one source. Colour is never the only signal: a label sits next to it. */
export function ClaimGlyph({ status }: { status: ClaimStatus }) {
  return <span className={'cg ' + status} aria-hidden="true" />;
}

export function EvidenceList({ evidence }: { evidence: readonly Evidence[] }) {
  if (!evidence.length) return null;
  return (
    <ul className="ev-list">
      {evidence.map((e, i) => {
        const href = quoteHref(e.url, e.quote);
        const against = e.stance === 'contradicts';
        const name = e.publisher || shortUrl(e.url, 32);
        return (
          <li key={e.docId + ':' + i} className={'ev-i' + (against ? ' against' : '')}>
            <blockquote className="q">{e.quote}</blockquote>
            <div className="ev-src">
              <span className={'stance' + (against ? ' against' : '')}>{against ? '反駁' : '支持'}</span>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" title={e.title || e.url}>
                  {name}
                </a>
              ) : (
                <span title={e.title || e.url}>{name}</span>
              )}
              <span className="ty">{sourceTypeLabel(e.sourceType)}</span>
              {e.duplicateOf ? (
                <span className="dup" title="這頁轉載自另一個來源，不算獨立佐證">
                  轉載
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ClaimItem({ claim }: { claim: Claim }) {
  const label = CLAIM_STATUS_LABEL[claim.status] ?? claim.status;
  return (
    <li className={'claim ' + claim.status}>
      <ClaimGlyph status={claim.status} />
      <div className="claim-b">
        <p className="claim-t">{claim.text}</p>
        <details className="claim-ev">
          <summary>
            <span className="claim-s">{label}</span> · {claimMeta(claim)}
          </summary>
          <EvidenceList evidence={claim.evidence} />
        </details>
      </div>
    </li>
  );
}

interface ClaimListProps {
  claims: readonly Claim[];
  /** Folded behind a summary line (used under a sub-UI, where the claims are secondary). */
  folded?: boolean;
}

function ClaimListImpl({ claims, folded = false }: ClaimListProps) {
  if (!claims.length) return null;
  const sorted = sortClaims(claims);
  const n = (s: ClaimStatus) => claims.filter((c) => c.status === s).length;
  const counts = (['corroborated', 'contested', 'asserted'] as const)
    .filter((s) => n(s) > 0)
    .map((s) => (
      <span key={s} className={'cc ' + s}>
        <ClaimGlyph status={s} />
        {CLAIM_STATUS_LABEL[s]} {n(s)}
      </span>
    ));
  const list = (
    <ul className="claims">
      {sorted.map((c) => (
        <ClaimItem key={c.claimId} claim={c} />
      ))}
    </ul>
  );
  if (folded) {
    return (
      <details className="claims-fold">
        <summary>
          查證過的主張 {claims.length} <span className="claim-counts">{counts}</span>
        </summary>
        {list}
      </details>
    );
  }
  return (
    <div className="claims-box">
      <div className="claims-hd">
        <span className="claims-h">查證過的主張</span>
        <span className="claim-counts">{counts}</span>
      </div>
      {list}
    </div>
  );
}

export const ClaimList = memo(ClaimListImpl);
