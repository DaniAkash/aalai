/**
 * GitHub token variables an agent child process would otherwise inherit.
 */
const INHERITABLE_TOKEN_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

let captured: Record<string, string> = {}

/**
 * Moves GitHub tokens out of `process.env` and into aalai's own keeping.
 *
 * The ACP runtime spawns the agent as a child process which inherits
 * `process.env`, and the provider exposes no way to scrub that child's
 * environment. Deleting the variables from the ambient environment means the
 * agent cannot inherit them, while {@link githubEnv} hands them back to aalai's
 * own gh and git commands, so an installation authenticated only by
 * `GH_TOKEN` keeps working.
 *
 * This narrows exposure; it is not a boundary. An agent with shell access runs
 * as the same user and can invoke an already-authenticated `gh` whose
 * credentials live in the keyring, which no process can hide from another
 * process running as its own user. The only real boundary is a sandboxed agent
 * backend. Until then the control that holds is delivery: aalai reviews the
 * diff and pushes, the agent cannot.
 *
 * @returns The names of the variables that were present and captured.
 */
export function captureInheritedTokens(): string[] {
  for (const name of INHERITABLE_TOKEN_VARS) {
    const value = process.env[name]
    if (value !== undefined) {
      captured[name] = value
      delete process.env[name]
    }
  }
  return Object.keys(captured)
}

/**
 * The environment aalai's own GitHub-facing commands run with: the captured
 * tokens put back, for this child process only.
 */
export function githubEnv(): Record<string, string> {
  return { ...captured }
}

/** Test seam. */
export function resetCapturedTokens(): void {
  captured = {}
}
