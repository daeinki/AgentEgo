import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
}).use(taskLists, { enabled: false, label: true, labelAfter: true });

md.renderer.rules['link_open'] = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]!;
  const aIndexRel = token.attrIndex('rel');
  if (aIndexRel < 0) token.attrPush(['rel', 'noopener noreferrer']);
  const aIndexTgt = token.attrIndex('target');
  if (aIndexTgt < 0) token.attrPush(['target', '_blank']);
  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(source: string): string {
  const raw = md.render(source);
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}
