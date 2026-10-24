import { memo } from 'react';
import { shortUrl } from '../lib/activity';
import { CLAIM_STATUS_LABEL, claimMeta, quoteHref, sortClaims } from '../lib/evidence';
import { sourceTypeLabel } from '../state';
import type { Claim, Evidence } from '../types';
import { Bars } from './Bars';

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
              <span className={'stance' + (against ? ' against' : '')}>{against ? '反對' : '支持'}</span>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" title={e.title || e.url}>
                  {name}
                </a>
              ) : (
                <span title={e.title || e.url}>{name}</span>
              )}
              <span>{sourceTypeLabel(e.sourceType)}</span>
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

export function ClaimItem({ claim }: { claim: Claim }) {
  const label = CLAIM_STATUS_LABEL[claim.status] ?? claim.status;
  return (
    <li className={'claim ' + claim.status}>
      <Bars strength={claim.status} support={claim.independentSources} against={claim.contradicting} />
      <div>
        <p className="claim-t">{claim.text}</p>
        <details className="claim-ev">
          <summary>
            <span className={'strength ' + claim.status}>{label}</span> · {claimMeta(claim)}
            {claim.updates ? ' · 取代了較舊的主張' : ''}
          </summary>
          <EvidenceList evidence={claim.evidence} />
        </details>
      </div>
    </li>
  );
}

function ClaimListImpl({ claims }: { claims: readonly Claim[] }) {
  if (!claims.length) return null;
  return (
    <ul className="claims">
      {sortClaims(claims).map((c) => (
        <ClaimItem key={c.claimId} claim={c} />
      ))}
    </ul>
  );
}

export const ClaimList = memo(ClaimListImpl);
