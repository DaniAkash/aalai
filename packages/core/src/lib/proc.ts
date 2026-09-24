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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
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
