import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import type { AgentCodeLanguage } from '@/components/agents/agent-code'

/**
 * Turning a stranger's markdown into html that is safe to insert.
 *
 * This file is the only place in the app that produces html from text somebody
 * else wrote, and `<Markdown>` is the only place that inserts it. Everything
 * here is written by reviewers, bots and whoever opened an issue, so the
 * sanitiser is not a precaution against a bug: it is the thing standing
 * between a review comment and script execution.
 *
 * Code never reaches here. Fences are split out before rendering and go to the
 * highlighter as text, so the one path that produces html only ever sees prose.
 */

const marked = new Marked({
  gfm: true,
  breaks: true,
})

/**
 * What a reviewer is allowed to produce, which is less than markdown can.
 *
 * An explicit allowlist rather than the sanitiser's defaults, because the
 * defaults permit things this interface has no styling for and no use for. A
 * tag not named here has its text kept and its markup dropped.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]

export function renderProse(markdown: string): string {
  const html = marked.parse(markdown, { async: false })
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
    // A link that is not http is a way to run something. Keeping the text and
    // dropping the destination leaves the sentence readable and inert.
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    // Nothing here needs an id, and one would let a comment collide with the
    // app's own elements.
    FORBID_ATTR: ['id', 'style', 'class'],
  })
}

/**
 * The highlighter's name for a fence label, or nothing.
 *
 * Unknown languages fall back rather than failing: a fence labelled with
 * something nobody precompiled should still render as code.
 */
const LANGUAGES: Record<string, AgentCodeLanguage> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  toml: 'toml',
  jsx: 'tsx',
  tsx: 'tsx',
  ts: 'typescript',
  typescript: 'typescript',
  js: 'typescript',
  javascript: 'typescript',
  yml: 'yaml',
  yaml: 'yaml',
}

export function languageFor(label: string): AgentCodeLanguage {
  return LANGUAGES[label.toLowerCase()] ?? 'text'
}
