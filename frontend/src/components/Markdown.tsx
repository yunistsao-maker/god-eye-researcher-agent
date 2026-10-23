import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { parseInline, parseMarkdown, type Block, type Inline } from '../lib/markdown';

/** Draws one [C3] citation. Without one, citations render as plain markers. */
export type CiteRenderer = (label: string) => ReactNode;

const plainCite: CiteRenderer = (label) => <span className="cite plain">{label}</span>;

/** Closing punctuation that must stay on the line of the citation before it. */
const CLOSING = /^[。，、；：！？）」』】》〉,.;:!?)\]]+/;

/** Text nodes only; React escapes them. No raw HTML is ever rendered. */
export function renderInline(list: Inline[], cite: CiteRenderer = plainCite): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    switch (n.t) {
      case 'text':
        out.push(<Fragment key={i}>{n.v}</Fragment>);
        break;
      case 'cite': {
        // A run of citations and the punctuation after it wrap as one unit, so 「。」 never starts a line.
        const run: ReactNode[] = [];
        let j = i;
        for (; j < list.length; j++) {
          const c = list[j];
          if (c.t !== 'cite') break;
          run.push(<Fragment key={j}>{cite(c.label)}</Fragment>);
        }
        const next = list[j];
        const tail = next && next.t === 'text' ? CLOSING.exec(next.v)?.[0] ?? '' : '';
        out.push(
          <span key={i} className="cite-run">
            {run}
            {tail}
          </span>,
        );
        if (tail && next.t === 'text') {
          const rest = next.v.slice(tail.length);
          if (rest) out.push(<Fragment key={j}>{rest}</Fragment>);
          j++;
        }
        i = j - 1;
        break;
      }
      case 'b':
        out.push(<strong key={i}>{renderInline(n.c, cite)}</strong>);
        break;
      case 'code':
        out.push(<code key={i}>{n.v}</code>);
        break;
      case 'a':
        out.push(
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {n.v}
          </a>,
        );
        break;
    }
  }
  return out;
}

const Caret = () => <span className="caret" aria-hidden="true" />;

function renderBlock(b: Block, key: number, caret: boolean, cite?: CiteRenderer): ReactNode {
  const tail = caret ? <Caret /> : null;
  switch (b.t) {
    case 'h':
      return b.level === 3 ? (
        <h3 key={key}>
          {renderInline(b.c, cite)}
          {tail}
        </h3>
      ) : (
        <h4 key={key}>
          {renderInline(b.c, cite)}
          {tail}
        </h4>
      );
    case 'p':
      return (
        <p key={key}>
          {renderInline(b.c, cite)}
          {tail}
        </p>
      );
    case 'ul':
    case 'ol': {
      const items = b.items.map((it, i) => (
        <li key={i}>
          {renderInline(it, cite)}
          {caret && i === b.items.length - 1 ? <Caret /> : null}
        </li>
      ));
      return b.t === 'ul' ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>;
    }
  }
}

interface Props {
  source: string;
  /** Show a blinking caret after the last character (while the text is still streaming). */
  caret?: boolean;
  /** How to draw [C#] claim citations. */
  cite?: CiteRenderer;
}

function MarkdownImpl({ source, caret = false, cite }: Props) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="md">
      {blocks.map((b, i) => renderBlock(b, i, caret && i === blocks.length - 1, cite))}
      {caret && !blocks.length ? (
        <p>
          <Caret />
        </p>
      ) : null}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

/** One line of inline markdown (bold, code, links), e.g. a contradiction or gap. */
export function InlineMarkdown({ text, cite }: { text: string; cite?: CiteRenderer }) {
  return <>{renderInline(parseInline(text), cite)}</>;
}
