/*
 * A tiny markdown subset for the synthesis report: ## / ### headings, paragraphs, "- " and "1. "
 * lists, **bold**, `code`, [text](https://…) links and claim citations [C3]. It parses to a small AST that the Markdown
 * component renders as React text nodes, so nothing in the source is ever interpreted as HTML.
 * Any other syntax (including raw HTML and links to other schemes) stays literal text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; v: string }
  /** A claim citation such as [C3]; `label` is "C3". */
  | { t: 'cite'; label: string };

export type Block =
  | { t: 'h'; level: 3 | 4; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] };

/** Returns a normalized http(s) URL, or null for anything else (javascript:, data:, relative…). */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// The citation form matches the backend's verify.MARKER: one claim per bracket, [C1][C2] for several.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^()\s]+)\)|\[(C\d{1,3})\]/g;

export function parseInline(src: string, allowBold = true): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += v;
    else out.push({ t: 'text', v });
  };
  let i = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    text(src.slice(i, at));
    i = at + m[0].length;
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[5] !== undefined) {
      // A space before a citation is only there to separate it from the text.
      const last = out[out.length - 1];
      if (last && last.t === 'text') last.v = last.v.replace(/[ \t]+$/, '');
      out.push({ t: 'cite', label: m[5] });
    } else if (m[2] !== undefined) {
      if (allowBold) out.push({ t: 'b', c: parseInline(m[2], false) });
      else text(m[0]);
    } else {
      const href = safeHref(m[4]);
      if (href) out.push({ t: 'a', href, v: m[3] });
      else text(m[0]);
    }
  }
  text(src.slice(i));
  return out;
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** Joins soft-wrapped lines: no space between CJK characters, a space otherwise. */
function joinLines(lines: string[]): string {
  let s = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!s) s = line;
    else s += CJK.test(s[s.length - 1]) && CJK.test(line[0]) ? line : ' ' + line;
  }
  return s;
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: string[][] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(joinLines(para)) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ t: list.t, items: list.items.map((it) => parseInline(joinLines(it))) });
    list = null;
  };

  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: 'h', level: h[1].length >= 3 ? 4 : 3, c: parseInline(h[2]) });
      continue;
    }
    const li = /^\s{0,3}(?:([-*])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (li) {
      const kind = li[1] ? 'ul' : 'ol';
      flushPara();
      if (list && list.t !== kind) flushList();
      if (!list) list = { t: kind, items: [] };
      list.items.push([li[3]]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1].push(line); // indented continuation of the last item
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
