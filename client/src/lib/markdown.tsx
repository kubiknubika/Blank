import type { ReactNode } from 'react';

/**
 * A tiny, SAFE markdown subset for notes: **bold**, *italic*, `code`,
 * [links](https://…), "- " lists, and paragraphs.
 *
 * Safety by construction: the renderer builds React elements, never
 * HTML strings — there is no dangerouslySetInnerHTML anywhere, so
 * <script> in a note is rendered as inert text. Links are restricted
 * to http(s): javascript: and data: URLs become plain text.
 * A full markdown parser dependency is not justified for notes fields.
 */

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;
const CODE_RE = /`([^`]+)`/g;

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Inline spans: code first (its content is literal), then bold/italic/links. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let k = 0;
  // Split out `code` spans; their content must not be further parsed.
  const codeParts = text.split(CODE_RE);
  codeParts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(<code key={`${keyBase}-c${k++}`}>{part}</code>);
      return;
    }
    // Within a non-code part, tokenize bold, then italic, then links.
    let segments: { text: string; kind: 'plain' | 'bold' | 'italic' }[] = [
      { text: part, kind: 'plain' },
    ];
    for (const [re, kind] of [
      [BOLD_RE, 'bold'],
      [ITALIC_RE, 'italic'],
    ] as const) {
      const next: typeof segments = [];
      for (const seg of segments) {
        if (seg.kind !== 'plain') {
          next.push(seg);
          continue;
        }
        let last = 0;
        for (const m of seg.text.matchAll(re)) {
          if (m.index! > last) next.push({ text: seg.text.slice(last, m.index), kind: 'plain' });
          next.push({ text: m[1], kind });
          last = m.index! + m[0].length;
        }
        if (last < seg.text.length) next.push({ text: seg.text.slice(last), kind: 'plain' });
      }
      segments = next;
    }
    for (const seg of segments) {
      if (seg.kind === 'bold') {
        out.push(<strong key={`${keyBase}-b${k++}`}>{seg.text}</strong>);
        continue;
      }
      if (seg.kind === 'italic') {
        out.push(<em key={`${keyBase}-i${k++}`}>{seg.text}</em>);
        continue;
      }
      // Plain text: linkify.
      let last = 0;
      for (const m of seg.text.matchAll(LINK_RE)) {
        if (m.index! > last) out.push(seg.text.slice(last, m.index));
        const href = safeHref(m[2]);
        if (href) {
          out.push(
            <a key={`${keyBase}-l${k++}`} href={href} target="_blank" rel="noreferrer">
              {m[1]}
            </a>,
          );
        } else {
          out.push(m[0]); // unsafe URL → literal text
        }
        last = m.index! + m[0].length;
      }
      if (last < seg.text.length) out.push(seg.text.slice(last));
    }
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let list: string[] = [];
  let para: string[] = [];
  let k = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(<p key={`p${k++}`}>{renderInline(para.join('\n'), `p${k}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`u${k++}`}>
        {list.map((item, i) => (
          <li key={i}>{renderInline(item, `u${k}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      flushPara();
      list.push(trimmed.slice(2));
      continue;
    }
    if (trimmed === '') {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return <div className="markdown">{blocks}</div>;
}
