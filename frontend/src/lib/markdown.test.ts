import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineMarkdown, Markdown } from '../components/Markdown';
import { parseInline, parseMarkdown, safeHref } from './markdown';

const html = (source: string, caret = false) => renderToStaticMarkup(createElement(Markdown, { source, caret }));

describe('parseMarkdown', () => {
  it('parses headings, paragraphs, lists, bold, code and links', () => {
    const blocks = parseMarkdown(['## 總結', '', '第一行', '第二行 and', 'more', '', '### 小節', '- 一 **粗體**', '- 二 `code`', '', '1. 第一', '2. [來源](https://example.com/a)'].join('\n'));
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'h', 'ul', 'ol']);
    expect(blocks[0]).toEqual({ t: 'h', level: 3, c: [{ t: 'text', v: '總結' }] });
    expect(blocks[1]).toEqual({ t: 'p', c: [{ t: 'text', v: '第一行第二行 and more' }] }); // no space between CJK lines
    expect(blocks[2]).toMatchObject({ t: 'h', level: 4 });
    expect(blocks[3]).toEqual({
      t: 'ul',
      items: [
        [{ t: 'text', v: '一 ' }, { t: 'b', c: [{ t: 'text', v: '粗體' }] }],
        [{ t: 'text', v: '二 ' }, { t: 'code', v: 'code' }],
      ],
    });
    expect(blocks[4]).toEqual({ t: 'ol', items: [[{ t: 'text', v: '第一' }], [{ t: 'a', href: 'https://example.com/a', v: '來源' }]] });
  });

  it('keeps unfinished syntax literal while it streams in', () => {
    expect(parseInline('還沒寫完的 **粗')).toEqual([{ t: 'text', v: '還沒寫完的 **粗' }]);
    expect(parseInline('[來源](https://exa')).toEqual([{ t: 'text', v: '[來源](https://exa' }]);
    expect(parseMarkdown('##')).toEqual([{ t: 'p', c: [{ t: 'text', v: '##' }] }]);
  });

  it('only allows http(s) links', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('http://example.com')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', '//evil.example/x', '/relative', 'vbscript:x']) expect(safeHref(bad)).toBeNull();
  });
});

describe('Markdown rendering', () => {
  it('renders the subset as HTML elements', () => {
    expect(html('## 標題\n\n段落 **粗** `c` [連結](https://example.com/a)\n\n- 項目')).toBe(
      '<div class="md"><h3>標題</h3><p>段落 <strong>粗</strong> <code>c</code> <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">連結</a></p><ul><li>項目</li></ul></div>',
    );
  });

  it('escapes raw HTML instead of rendering it', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>x</b>** `<i>y</i>`');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<i>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(out).toContain('<code>&lt;i&gt;y&lt;/i&gt;</code>');
  });

  it('does not turn javascript:, data: or relative links into anchors', () => {
    const out = html('[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,x) [d](//evil.example)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).toContain('[a](javascript:alert(1))');
  });

  it('cannot break out of the href attribute', () => {
    const out = html('[x](https://example.com/"onmouseover="x)');
    expect(out).not.toContain('onmouseover="');
    expect(out).toContain('href="https://example.com/%22onmouseover=%22x"');
  });

  it('puts the caret after the last character, including an empty stream', () => {
    expect(html('段落\n\n- a\n- b', true)).toBe('<div class="md"><p>段落</p><ul><li>a</li><li>b<span class="caret" aria-hidden="true"></span></li></ul></div>');
    expect(html('', true)).toBe('<div class="md"><p><span class="caret" aria-hidden="true"></span></p></div>');
    expect(html('x')).not.toContain('caret');
  });

  it('InlineMarkdown renders one line safely', () => {
    expect(renderToStaticMarkup(createElement(InlineMarkdown, { text: '**F3** 與 <u>F5</u>' }))).toBe('<strong>F3</strong> 與 &lt;u&gt;F5&lt;/u&gt;');
  });
});

describe('claim citations', () => {
  it('parses [C#] markers (one claim per bracket) and drops the space before them', () => {
    expect(parseInline('多數廠商保留 AOI [C1][C12]。')).toEqual([
      { t: 'text', v: '多數廠商保留 AOI' },
      { t: 'cite', label: 'C1' },
      { t: 'cite', label: 'C12' },
      { t: 'text', v: '。' },
    ]);
    expect(parseInline('**粗體 [C2]**')).toEqual([{ t: 'b', c: [{ t: 'text', v: '粗體' }, { t: 'cite', label: 'C2' }] }]);
  });

  it('leaves look-alikes as text', () => {
    expect(parseInline('[C1, C2] [c3] [C1234] [F2]')).toEqual([{ t: 'text', v: '[C1, C2] [c3] [C1234] [F2]' }]);
    expect(parseInline('[C1](https://example.com/x)')).toEqual([{ t: 'a', href: 'https://example.com/x', v: 'C1' }]);
  });

  it('renders citations with the given renderer, or as plain markers', () => {
    const plain = renderToStaticMarkup(createElement(InlineMarkdown, { text: '主張 [C3]' }));
    expect(plain).toBe('主張<span class="cite-run"><span class="cite plain">C3</span></span>');
    // citations and the closing punctuation after them wrap together
    const run = renderToStaticMarkup(createElement(InlineMarkdown, { text: '主張 [C1][C2]。下一句' }));
    expect(run).toBe('主張<span class="cite-run"><span class="cite plain">C1</span><span class="cite plain">C2</span>。</span>下一句');
    const custom = renderToStaticMarkup(
      createElement(Markdown, { source: '- 一 [C1]', cite: (label: string) => createElement('button', { className: 'cite' }, label) }),
    );
    expect(custom).toContain('<li>一<span class="cite-run"><button class="cite">C1</button></span></li>');
  });
});
