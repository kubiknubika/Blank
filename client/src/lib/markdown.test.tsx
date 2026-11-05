// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Markdown } from './markdown';

afterEach(cleanup);

describe('Markdown (safe subset)', () => {
  it('renders bold, italic, and inline code', () => {
    const { container } = render(<Markdown text={'**bold** and *italic* and `code()`'} />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code()');
  });

  it('code spans are literal — no formatting inside them', () => {
    const { container } = render(<Markdown text={'`**not bold**`'} />);
    expect(container.querySelector('code')?.textContent).toBe('**not bold**');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('renders http(s) links with rel=noreferrer', () => {
    render(<Markdown text={'see [docs](https://example.com/a?b=1)'} />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('javascript: and data: URLs render as inert text, never anchors', () => {
    const { container } = render(
      <Markdown text={'[click](javascript:alert(1)) [x](data:text/html,<script>)'} />,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });

  it('raw HTML in notes is inert text (no dangerouslySetInnerHTML)', () => {
    const { container } = render(
      <Markdown text={'<script>alert(1)</script> <img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders "- " lists and paragraphs', () => {
    const { container } = render(<Markdown text={'first para\n\n- one\n- **two**\n\nlast para'} />);
    expect(container.querySelectorAll('p')).toHaveLength(2);
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[1].querySelector('strong')?.textContent).toBe('two');
  });

  it('single newlines inside a paragraph are preserved', () => {
    const { container } = render(<Markdown text={'line1\nline2'} />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.textContent).toContain('line1\nline2');
  });
});
