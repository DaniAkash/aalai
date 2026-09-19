import { homedir } from 'node:os'
import { workbenchDir } from '@/config'

/**
 * Absolute-path prefixes that identify a machine rather than a repository.
 *
 * The list is not the mechanism: the generic rule below is. These only exist so
 * a path under a known root is rewritten to something still useful to a reader
 * rather than replaced wholesale.
 */
function localRoots(worktree: string): string[] {
  const roots = [worktree, workbenchDir(), homedir(), '/tmp', '/private/tmp', '/var/folders', '/root']
  // Longest first, so the most specific root wins and a worktree under the
  // workbench is not truncated to the workbench.
  return [...new Set(roots.filter((r) => r !== ''))].sort((a, b) => b.length - a.length)
}

/** Directory names that mark where the repository-relative part of a path begins. */
const REPO_ANCHOR = /\/(?:src|test|tests|lib|app|apps|packages|docs|scripts|evals|bin)\//

/**
 * Rewrites machine-local paths out of text that is about to be published.
 *
 * Stations report from inside a worktree, so they cite files by absolute path.
 * Those paths carry the machine's directory layout and its username, and the
 * text goes verbatim into a pull request body or an issue comment. Nobody
 * reading either can use them, and they should not be published in any case.
 *
 * Every string a station authored passes through here, not just the
 * implementer's report: the reviewer's evidence fields are precisely where file
 * citations appear.
 */
export function redactLocalPaths(text: string, worktree: string): string {
  let out = text
  for (const root of localRoots(worktree)) {
    out = out.split(`${root}/`).join('').split(root).join('.')
  }
  // Anything still absolute is a root we did not anticipate. Keep the
  // repository-relative tail when there is one, and drop the rest.
  //
  // The lookbehind excludes `:` and `/` so a URL is left alone. Without it
  // `https://github.com/owner/repo/pull/14` matches at the `//` after the
  // scheme and the whole link is destroyed, which a live run caught by
  // publishing a pull request URL as `https:/<local path>`.
  return out.replace(/(?<![\w.:/])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g, (match) => {
    const anchor = match.match(REPO_ANCHOR)
    if (anchor === null) {
      return '<local path>'
    }
    return match.slice(match.indexOf(anchor[0]) + 1)
  })
}

/** Applies {@link redactLocalPaths} across every string in a station's structured output. */
export function redactDeep<T>(value: T, worktree: string): T {
  if (typeof value === 'string') {
    return redactLocalPaths(value, worktree) as T
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, worktree)) as T
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDeep(entry, worktree)]),
    ) as T
  }
  return value
}
