import { describe, expect, it } from 'vitest';
import { claimMeta, pct, quoteHref, sortClaims } from './evidence';

describe('quoteHref', () => {
  it('adds a text fragment that highlights the quote', () => {
    expect(quoteHref('https://example.com/a', '多數廠商保留 AOI 設備')).toBe(
      'https://example.com/a#:~:text=' + encodeURIComponent('多數廠商保留 AOI 設備'),
    );
    // `-`, `,` and `&` are text-fragment syntax and must be escaped
    expect(quoteHref('https://example.com/a', 'cost-down, fast & cheap')).toBe('https://example.com/a#:~:text=cost%2Ddown%2C%20fast%20%26%20cheap');
  });

  it('uses a start,end range for long quotes, cut on words when the text has spaces', () => {
    const words = Array.from({ length: 30 }, (_, i) => 'w' + i).join(' ');
    expect(quoteHref('https://example.com/a', words)).toBe('https://example.com/a#:~:text=w0%20w1%20w2%20w3%20w4,w25%20w26%20w27%20w28%20w29');
    const cjk = '甲'.repeat(50) + '乙'.repeat(50);
    expect(quoteHref('https://example.com/a', cjk)).toBe(
      'https://example.com/a#:~:text=' + encodeURIComponent('甲'.repeat(24)) + ',' + encodeURIComponent('乙'.repeat(24)),
    );
  });

  it('keeps an existing fragment and refuses other schemes', () => {
    expect(quoteHref('https://example.com/a#part', 'x')).toBe('https://example.com/a#part:~:text=x');
    expect(quoteHref('javascript:alert(1)', 'x')).toBeNull();
    expect(quoteHref('https://example.com/a', '  ')).toBe('https://example.com/a');
  });
});

describe('claim display', () => {
  it('describes the support behind a claim', () => {
    expect(claimMeta({ status: 'corroborated', independentSources: 3, supporting: 3, contradicting: 0 })).toBe('3 個獨立來源');
    expect(claimMeta({ status: 'asserted', independentSources: 1, supporting: 2, contradicting: 0 })).toBe('1 個獨立來源');
    expect(claimMeta({ status: 'contested', independentSources: 1, supporting: 1, contradicting: 1 })).toBe('1 支持 · 1 反對');
  });

  it('lists corroborated, then contested, then single-source claims, stable within a status', () => {
    const order = sortClaims([
      { id: 'a', status: 'asserted' as const },
      { id: 'b', status: 'corroborated' as const },
      { id: 'c', status: 'contested' as const },
      { id: 'd', status: 'corroborated' as const },
    ]).map((c) => c.id);
    expect(order).toEqual(['b', 'd', 'c', 'a']);
  });

  it('formats shares', () => {
    expect(pct(0.875)).toBe('88%');
    expect(pct(null)).toBe('—');
  });
});
