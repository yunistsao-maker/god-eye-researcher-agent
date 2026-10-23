/*
 * Display helpers for the evidence backbone (claims, quotes, coverage). Pure functions, no React.
 */
import type { Claim, ClaimStatus, CoverageStatus } from '../types';
import { safeHref } from './markdown';

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  corroborated: '已證實',
  asserted: '單一來源',
  contested: '有爭議',
  superseded: '已被取代',
};

export const COVERAGE_LABEL: Record<CoverageStatus | 'pending', string> = {
  covered: '已涵蓋',
  weak: '證據薄弱',
  missing: '尚無資料',
  pending: '待檢查',
};

/** "2 個獨立來源" / "1 支持 · 1 反駁". */
export function claimMeta(c: Pick<Claim, 'status' | 'independentSources' | 'supporting' | 'contradicting'>): string {
  if (c.status === 'contested') return `${c.supporting} 支持 · ${c.contradicting} 反對`;
  if (c.status === 'superseded') return '已被較新的證據取代';
  const n = Math.max(1, c.independentSources || 0);
  return `${n} 個獨立來源`;
}

/** Corroborated first, then contested (the reader should see disagreements), then single-source. */
const CLAIM_RANK: Record<ClaimStatus, number> = { corroborated: 0, contested: 1, asserted: 2, superseded: 3 };
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

/* ---------------- strength of a group of claims (a finding, a paragraph, a section) ---------------- */

export type Strength = 'corroborated' | 'contested' | 'asserted' | 'none';

export interface StrengthSummary {
  strength: Strength;
  /** Distinct publishers supporting the claims. */
  support: number;
  /** Distinct publishers contradicting them. */
  against: number;
  /** Quotes from syndicated copies (merged into their original). */
  duplicates: number;
  /** Latest publication date among the quoted pages (YYYY-MM), if known. */
  latest: string | null;
  claims: number;
}

/**
 * One verdict for several claims: contested if any is contested, verified when most are corroborated,
 * otherwise single-source. `dates` maps docId → publishedDate for the "最新證據" line.
 */
export function strengthOf(claims: readonly Claim[], dates: ReadonlyMap<string, string | null | undefined> = new Map()): StrengthSummary {
  const live = claims.filter((c) => c.status !== 'superseded');
  const support = new Set<string>();
  const against = new Set<string>();
  let duplicates = 0;
  let latest: string | null = null;
  for (const c of live) {
    for (const e of c.evidence) {
      (e.stance === 'contradicts' ? against : support).add(e.publisher || e.url);
      if (e.duplicateOf) duplicates++;
      const d = dates.get(e.docId);
      if (d && (!latest || d > latest)) latest = d;
    }
  }
  let strength: Strength = 'none';
  if (live.some((c) => c.status === 'contested')) strength = 'contested';
  else if (live.length && live.filter((c) => c.status === 'corroborated').length * 2 >= live.length) strength = 'corroborated';
  else if (live.length) strength = 'asserted';
  return { strength, support: support.size, against: against.size, duplicates, latest: latest ? latest.slice(0, 7) : null, claims: live.length };
}

export const STRENGTH_LABEL: Record<Strength, string> = { corroborated: '已證實', contested: '有爭議', asserted: '單一來源', none: '沒有引用' };

/** "4 個獨立來源支持" / "2 支持、2 反對" / "1 個來源". */
export function strengthLine(s: StrengthSummary): string {
  if (s.strength === 'contested') return `${s.support} 個獨立來源支持、${s.against} 個反對`;
  if (s.strength === 'corroborated') return `${s.support} 個獨立來源支持`;
  if (s.strength === 'asserted') return s.support > 1 ? `多數主張只有單一來源` : '只有 1 個來源';
  return '這段沒有引用主張';
}

/** First sentence of a summary (for a card title) and the rest. */
export function splitLead(text: string): [string, string] {
  const t = text.trim();
  const m = /^(.{8,}?[。！？!?]|.{8,}?\.(?=\s))\s*/u.exec(t);
  if (!m || m[0].length >= t.length - 2) return [t, ''];
  return [m[1], t.slice(m[0].length).trim()];
}

/** "剛剛" / "3 分鐘前" / "2 小時前". */
export function relTime(fromMs: number | null | undefined, nowMs: number): string {
  if (!fromMs) return '';
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 45) return '剛剛';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
}

/** YYYY-MM-DD in local time. */
export function ymd(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** HH:MM in local time. */
export function hm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const PRIMARY_TYPES: readonly string[] = ['government', 'standards', 'academic', 'official'];

/** Source-type groups used by the evidence desk's filter. */
export function typeGroup(t: string | undefined): 'primary' | 'research' | 'news' | 'other' {
  if (t && PRIMARY_TYPES.includes(t)) return 'primary';
  if (t === 'research') return 'research';
  if (t === 'news' || t === 'community' || t === 'reference') return 'news';
  return 'other';
}

export const TYPE_GROUP_LABEL: Record<ReturnType<typeof typeGroup>, string> = { primary: '一手來源', research: '研究與調查', news: '新聞與社群', other: '其他' };
