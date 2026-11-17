import DOMPurify from 'dompurify';
import { marked } from 'marked';

export type RichTextFormat = 'html' | 'markdown';

// Azure DevOps stores work item descriptions as HTML and pull request descriptions as Markdown, but either can
// contain plain text. Anything that does not look like block-level HTML goes through the Markdown renderer, which
// leaves plain text readable (paragraphs and line breaks are preserved).
const HTML_HINT = /<\s*(p|div|br|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|pre|blockquote|span|b|strong|i|em|u|a|img|font|hr)\b[^>]*>/i;

export function detectFormat(text: string): RichTextFormat {
  const trimmed = text.trim();
  if (/^<\s*[a-z!]/i.test(trimmed) && HTML_HINT.test(trimmed)) return 'html';
  return 'markdown';
}

const FORBIDDEN_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'link', 'meta', 'base', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas'];
const FORBIDDEN_ATTRS = ['style', 'srcset', 'formaction', 'action', 'id', 'name'];

const SAFE_HREF = /^(https?:|mailto:|#)/i;

/**
 * Turns a work item / pull request description into HTML that is safe to inject: scripts, event handlers,
 * javascript: URLs, forms and embedded content are removed. Images are replaced by a link to their source
 * (Azure DevOps attachments need authentication and would otherwise show as broken images and leak requests).
 */
export function renderRichText(text: string): string {
  if (!text.trim()) return '';
  const html = detectFormat(text) === 'html' ? text : (marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRS,
    ALLOW_DATA_ATTR: false,
  });

  // The sanitized string is parsed into an inert <template>: nothing in it is loaded or executed.
  const template = document.createElement('template');
  template.innerHTML = clean;
  template.content.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    const label = img.getAttribute('alt') || src || 'image';
    if (SAFE_HREF.test(src) && !src.startsWith('#')) {
      const link = document.createElement('a');
      link.setAttribute('href', src);
      link.textContent = `[${label}]`;
      img.replaceWith(link);
    } else {
      img.replaceWith(document.createTextNode(`[${label}]`));
    }
  });
  template.content.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!SAFE_HREF.test(href)) {
      a.removeAttribute('href');
      return;
    }
    if (!href.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return template.innerHTML;
}
