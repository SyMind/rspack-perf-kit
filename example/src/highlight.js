import hljs from 'highlight.js/lib/common';

export function highlight(code) {
  return hljs.highlight(code, { language: 'javascript' }).value;
}
