/*
 * Display helpers for the evidence backbone (claims, quotes, coverage). Pure functions, no React.
 */
import type { Claim, ClaimStatus, CoverageStatus } from '../types';
import { safeHref } from './markdown';

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  corroborated: '已佐證',
  asserted: '單一來源',
  contested: '有爭議',
};

export const COVERAGE_LABEL: Record<CoverageStatus | 'pending', string> = {
  covered: '已涵蓋',
  weak: '證據薄弱',
  missing: '尚無資料',
  pending: '待檢查',
};

/** "2 個獨立來源" / "1 支持 · 1 反駁". */
export function claimMeta(c: Pick<Claim, 'status' | 'independentSources' | 'supporting' | 'contradicting'>): string {
  if (c.status === 'contested') return `${c.supporting} 支持 · ${c.contradicting} 反駁`;
  const n = Math.max(1, c.independentSources || 0);
  return `${n} 個獨立來源`;
}

/** Corroborated first, then contested (the reader should see disagreements), then single-source. */
const CLAIM_RANK: Record<ClaimStatus, number> = { corroborated: 0, contested: 1, asserted: 2 };
export function sortClaims<T extends Pick<Claim, 'status'>>(claims: readonly T[]): T[] {
  return claims
    .map((c, i) => [c, i] as const)
    .sort((a, b) => (CLAIM_RANK[a[0].status] ?? 3) - (CLAIM_RANK[b[0].status] ?? 3) || a[1] - b[1])
    .map(([c]) => c);
}

/** Encodes text for a URL text fragment; `-`, `,` and `&` are syntax there. */
function encodeFragment(s: string): string {
  return encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
}

const SPACED = /\s/;

/**
 * Link to the page that scrolls to and highlights the quote in browsers with text fragments
 * (`#:~:text=`); others simply open the page. Returns null for non-http(s) URLs.
 */
export function quoteHref(url: string, quote: string): string | null {
  const href = safeHref(url);
  if (!href) return null;
  const q = quote.trim().replace(/\s+/g, ' ');
  if (!q) return href;
  let directive: string;
  const chars = Array.from(q);
  if (chars.length <= 80) directive = encodeFragment(q);
  else if (SPACED.test(q)) {
    // Text fragments match whole words, so cut on spaces: first and last five words.
    const words = q.split(' ');
    directive = words.length > 10 ? encodeFragment(words.slice(0, 5).join(' ')) + ',' + encodeFragment(words.slice(-5).join(' ')) : encodeFragment(q);
  } else {
    directive = encodeFragment(chars.slice(0, 24).join('')) + ',' + encodeFragment(chars.slice(-24).join(''));
  }
  return href + (href.includes('#') ? ':~:text=' : '#:~:text=') + directive;
}

/** "0.6" → "60%". */
export function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) + '%' : '—';
}
