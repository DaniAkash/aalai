'use client'

import { type CSSProperties, Fragment, useEffect, useState } from 'react'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRawEngine } from 'shiki/engine/javascript'
import { cn } from '@/lib/utils'

/**
 * The languages a repository aalai watches is likely to contain.
 *
 * Every entry is a grammar bundled at build time, so this list is the whole
 * cost. Adding one is a line here and a line in LANGS below; forgetting to
 * add one renders that file as plain text rather than failing.
 */
export type AgentCodeLanguage =
  | 'bash'
  | 'diff'
  | 'go'
  | 'json'
  | 'markdown'
  | 'python'
  | 'rust'
  | 'text'
  | 'toml'
  | 'tsx'
  | 'typescript'
  | 'yaml'

export interface AgentCodeToken {
  content: string
  offset: number
  light?: string
  dark?: string
}

export type AgentCodeTokenLines = AgentCodeToken[][]

export interface AgentCodeProps {
  code: string
  language?: AgentCodeLanguage
  className?: string
}

export interface AgentCodeLineProps {
  code: string
  tokens?: AgentCodeToken[]
  className?: string
}

const LIGHT_THEME = 'github-light-high-contrast'
const DARK_THEME = 'github-dark-high-contrast'

/**
 * A fine grained bundle rather than the `shiki` entry point.
 *
 * The registry ships this file importing `shiki`, which is every grammar and
 * every theme: 9.6 MB of the build to highlight a handful of languages. These
 * imports are what ships instead, and the precompiled grammars skip the regex
 * translation the oniguruma engine would otherwise do at runtime, so there is
 * no WebAssembly to load either.
 */
const LANGS = [
  import('@shikijs/langs-precompiled/bash'),
  import('@shikijs/langs-precompiled/diff'),
  import('@shikijs/langs-precompiled/go'),
  import('@shikijs/langs-precompiled/json'),
  import('@shikijs/langs-precompiled/markdown'),
  import('@shikijs/langs-precompiled/python'),
  import('@shikijs/langs-precompiled/rust'),
  import('@shikijs/langs-precompiled/toml'),
  import('@shikijs/langs-precompiled/tsx'),
  import('@shikijs/langs-precompiled/typescript'),
  import('@shikijs/langs-precompiled/yaml'),
]

let agentCodeHighlighter: Promise<HighlighterCore> | null = null

function getAgentCodeHighlighter() {
  if (!agentCodeHighlighter) {
    agentCodeHighlighter = createHighlighterCore({
      themes: [
        import('@shikijs/themes/github-light-high-contrast'),
        import('@shikijs/themes/github-dark-high-contrast'),
      ],
      langs: LANGS,
      engine: createJavaScriptRawEngine(),
    })
  }
  return agentCodeHighlighter
}

/**
 * Highlighting is a cache of last resort, not a store.
 *
 * The key is the whole source text, so an unbounded map holds every version of
 * every file a long session ever rendered. A desktop app stays open for days.
 */
const CACHE_LIMIT = 120
const tokenCache = new Map<string, AgentCodeTokenLines>()

function cacheTokens(key: string, lines: AgentCodeTokenLines) {
  if (tokenCache.size >= CACHE_LIMIT) {
    const oldest = tokenCache.keys().next()
    if (!oldest.done) tokenCache.delete(oldest.value)
  }
  tokenCache.set(key, lines)
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
  return `${language}\u0000${code}`
}

export function useAgentCodeTokens(code: string, language: AgentCodeLanguage) {
  const key = tokenCacheKey(code, language)
  const cached = tokenCache.get(key)
  const [result, setResult] = useState<{
    key: string
    code: string
    language: AgentCodeLanguage
    lines: AgentCodeTokenLines
  } | null>(cached ? { key, code, language, lines: cached } : null)

  useEffect(() => {
    const current = tokenCache.get(key)
    if (current) {
      setResult({ key, code, language, lines: current })
      return
    }

    // `text` has no grammar to load and nothing to colour, so it skips the
    // highlighter entirely rather than resolving a bundle to return no spans.
    if (language === 'text') {
      setResult({ key, code, language, lines: [] })
      return
    }

    let cancelled = false
    getAgentCodeHighlighter().then((highlighter) => {
      if (cancelled) return
      const lines = highlighter
        .codeToTokensWithThemes(code, {
          lang: language,
          themes: {
            light: LIGHT_THEME,
            dark: DARK_THEME,
          },
        })
        .map((line) =>
          line.map((token) => ({
            content: token.content,
            offset: token.offset,
            light: token.variants.light?.color,
            dark: token.variants.dark?.color,
          })),
        )
      cacheTokens(key, lines)
      setResult({ key, code, language, lines })
    })
    return () => {
      cancelled = true
    }
  }, [code, key, language])

  if (result?.key === key) return result.lines
  if (result?.language === language && code.startsWith(result.code)) {
    return result.lines
  }
  return null
}

export function AgentCodeLine({ code, tokens, className }: AgentCodeLineProps) {
  return (
    <span className={className}>
      {tokens
        ? tokens.map((token) => (
            <span
              key={`${token.offset}-${token.content}`}
              style={
                {
                  '--agent-code-light': token.light ?? 'currentColor',
                  '--agent-code-dark':
                    token.dark ?? token.light ?? 'currentColor',
                } as CSSProperties
              }
              className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
            >
              {token.content}
            </span>
          ))
        : code}
    </span>
  )
}

export function AgentCode({
  code,
  language = 'bash',
  className,
}: AgentCodeProps) {
  const tokens = useAgentCodeTokens(code, language)
  let offset = 0
  const lines = code.split('\n').map((content) => {
    const line = { content, offset }
    offset += content.length + 1
    return line
  })

  return (
    <pre
      className={cn(
        'm-0 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/85',
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={line.offset}>
            <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
            {index < lines.length - 1 ? '\n' : null}
          </Fragment>
        ))}
      </code>
    </pre>
  )
}
