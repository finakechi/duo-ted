/**
 * Markdown for model output. Everything goes through DOMPurify: this window can approve agent
 * actions, so model-written HTML must never execute.
 */
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Marked } from 'marked';

for (const [name, lang] of Object.entries({ bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['rs'], { languageName: 'rust' });

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function highlight(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    if (code.length < 12_000) return hljs.highlightAuto(code).value;
  } catch {
    /* fall through */
  }
  return esc(code);
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? '').split(/\s/)[0];
      return `<div class="codeblock"><div class="codeblock-head"><span>${esc(l)}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code class="hljs">${highlight(text, l)}</code></pre></div>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') ?? '';
  // Models often "link" file references (stats.py:2-4); those are not pages, so keep them as text.
  if (!/^(https?:|mailto:)/i.test(href)) {
    node.removeAttribute('href');
    node.setAttribute('class', 'ref');
    return;
  }
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

/**
 * Rendered output by source text, most recently used last. Opening a chat again (or a run's
 * report) re-rendered every message: parsing, highlighting and sanitizing were most of the time a
 * long conversation took to open. The output is already sanitized, and the same source always
 * renders the same, so it can be reused. Bounded by total size.
 */
const rendered = new Map<string, string>();
let renderedSize = 0;
let lastRendered = '';
const RENDERED_MAX = 8 * 1024 * 1024;

function forget(key: string): void {
  const v = rendered.get(key);
  if (v === undefined) return;
  rendered.delete(key);
  renderedSize -= key.length + v.length;
}

export function renderMarkdown(src: string): string {
  const hit = rendered.get(src);
  if (hit !== undefined) {
    rendered.delete(src);
    rendered.set(src, hit);
    return hit;
  }
  const html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string, { ADD_ATTR: ['data-copy', 'target'] });
  // A reply streaming in grows on every update: keep only its latest text, not every prefix.
  if (lastRendered && src.startsWith(lastRendered)) forget(lastRendered);
  lastRendered = src;
  if (src.length <= 512 * 1024) {
    rendered.set(src, html);
    renderedSize += src.length + html.length;
    for (const k of rendered.keys()) {
      if (renderedSize <= RENDERED_MAX) break;
      forget(k);
    }
  }
  return html;
}

/** One delegated handler for every Copy button inside rendered markdown. */
export function onCopyClick(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest('[data-copy]');
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
  void navigator.clipboard.writeText(code);
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy'), 1200);
}
