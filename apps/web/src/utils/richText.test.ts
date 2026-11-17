// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectFormat, renderRichText } from './richText';

describe('renderRichText', () => {
  it('detects HTML, Markdown and plain text', () => {
    expect(detectFormat('<p>Hello</p>')).toBe('html');
    expect(detectFormat('<div>Steps<br>1. Open</div>')).toBe('html');
    expect(detectFormat('## Title\n\n- a\n- b')).toBe('markdown');
    expect(detectFormat('just a plain sentence')).toBe('markdown');
    expect(detectFormat('use a < b and c > d')).toBe('markdown');
  });

  it('renders Markdown from a long pull request description in full', () => {
    const source = '## Summary\n\n' + Array.from({ length: 80 }, (_, i) => `- change ${i} with **bold** and \`code\``).join('\n');
    const html = renderRichText(source);
    expect(html).toContain('<h2');
    expect(html.match(/<li>/g)).toHaveLength(80);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('change 79');
  });

  it('keeps plain text readable, including line breaks', () => {
    const html = renderRichText('First line\nSecond line\n\nNew paragraph');
    expect(html).toContain('First line');
    expect(html).toContain('<br>');
    expect(html).toContain('<p>New paragraph</p>');
  });

  it('renders Azure DevOps HTML (Task description and Bug repro steps)', () => {
    const html = renderRichText('<div>Do the thing</div><ol><li>Open the page</li><li>Click <b>Save</b></li></ol>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<b>Save</b>');
  });

  it('blocks scripts, event handlers, javascript: links, styles and embedded content', () => {
    const hostile = [
      '<p onclick="alert(1)">x</p><script>alert(1)</script>',
      '<a href="javascript:alert(1)">click</a>',
      '<iframe src="https://example.com"></iframe><object data="x"></object><embed src="x">',
      '<form action="https://example.com"><input name="a"><button>go</button></form>',
      '<style>body{display:none}</style><div style="position:fixed">x</div>',
      '<svg onload="alert(1)"><script>alert(1)</script></svg>',
      '[md link](javascript:alert(1)) <img src=x onerror=alert(1)>',
    ].map(renderRichText).join('\n');
    expect(hostile).not.toMatch(/<script|<iframe|<object|<embed|<form|<input|<button|<style|<svg/i);
    expect(hostile).not.toMatch(/onclick|onerror|onload|javascript:|style=/i);
  });

  it('opens links safely and replaces images with a link to the source', () => {
    const html = renderRichText('<a href="https://example.com/a">a</a> <img src="https://example.com/i.png" alt="shot">');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('<img');
    expect(html).toContain('[shot]');
  });

  it('returns nothing for an empty description', () => {
    expect(renderRichText('')).toBe('');
    expect(renderRichText('   \n ')).toBe('');
  });
});
