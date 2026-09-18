/**
 * Rewrites machine-local paths out of text that is about to be published.
 *
 * A station reports from inside its worktree, so it cites files by absolute
 * path. Those paths carry the machine's directory layout and username, and the
 * report goes verbatim into a pull request body. Nobody reading that pull
 * request can use them, and they should not be published in any case.
 *
 * @param text - Agent-authored prose.
 * @param worktree - The absolute worktree root to rewrite to repository-relative.
 */
export function redactLocalPaths(text: string, worktree: string): string {
  const withoutWorktree = text.split(`${worktree}/`).join('').split(worktree).join('.')
  // A station may also cite a sibling checkout, so strip any remaining home
  // directory prefix rather than trusting that one root covers it.
  return withoutWorktree.replace(/\/(?:Users|home)\/[^\s)"'`\]]+/g, (match) => {
    const marker = match.match(/\/(?:src|test|tests|lib|app|packages|docs)\//)
    return marker === null ? '<path>' : match.slice(match.indexOf(marker[0]) + 1)
  })
}
