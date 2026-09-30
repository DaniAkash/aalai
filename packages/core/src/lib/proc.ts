class ProcError extends Error {
  readonly exitCode: number
  readonly stderr: string
  readonly command: string

  constructor(command: string, exitCode: number, stderr: string) {
    super(`\`${command}\` exited ${exitCode}: ${stderr.trim().slice(0, 600)}`)
    this.name = 'ProcError'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdin?: string
  /**
   * Kills the child when this fires, and waits for it to be gone.
   *
   * Needed wherever stopping has to mean stopped rather than stopped waiting. A
   * review that loses its claim is about to have its checkout deleted and
   * another machine started on the same pull request, and a test run left alive
   * would still be executing that checkout while both of those happen.
   */
  readonly signal?: AbortSignal
}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export async function exec(
  command: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin:
      options.stdin === undefined
        ? 'ignore'
        : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Killed rather than abandoned. `proc.exited` is awaited below whatever
  // happens, so an aborted call returns once the child is actually gone and a
  // caller that deletes the directory afterwards is not racing it.
  const kill = () => {
    proc.kill()
  }
  // Checked as well as listened for. A signal that had already aborted before
  // this was called never fires the event, so listening alone meant a command
  // started after the claim was lost ran to completion: exactly the case where
  // stopping matters most.
  if (options.signal?.aborted === true) {
    kill()
  } else {
    options.signal?.addEventListener('abort', kill, { once: true })
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    options.signal?.removeEventListener('abort', kill)
  }
}

/** Runs a command and returns trimmed stdout, throwing {@link ProcError} on a nonzero exit. */
export async function execOrThrow(
  command: readonly string[],
  options: ExecOptions = {},
): Promise<string> {
  const result = await exec(command, options)
  if (result.exitCode !== 0) {
    throw new ProcError(
      command.join(' '),
      result.exitCode,
      result.stderr || result.stdout,
    )
  }
  return result.stdout.trim()
}
