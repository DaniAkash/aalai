/**
 * GitHub token variables an agent child process would otherwise inherit.
 */
const INHERITABLE_TOKEN_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

/**
 * Removes GitHub tokens from this process's environment at startup.
 *
 * The ACP runtime spawns the agent as a child process, which inherits
 * `process.env`, and the provider exposes no way to scrub that child's
 * environment. aalai does not need these variables (the gh CLI reads its own
 * stored credentials), so deleting them means there is nothing to inherit.
 *
 * This narrows the exposure; it is not a boundary. An agent with shell access
 * still runs as the same user and can invoke an already-authenticated `gh`
 * whose credentials live in the keyring or in gh's config, neither of which a
 * process can hide from another process running as its own user. The only real
 * boundary is a sandboxed agent backend. Until then, the control that actually
 * holds is delivery: aalai reviews the diff and pushes, the agent cannot.
 *
 * @returns The names of the variables that were present and removed.
 */
export function scrubInheritedTokens(): string[] {
  const removed: string[] = []
  for (const name of INHERITABLE_TOKEN_VARS) {
    if (process.env[name] !== undefined) {
      delete process.env[name]
      removed.push(name)
    }
  }
  return removed
}
