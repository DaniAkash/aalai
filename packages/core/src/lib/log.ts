import { logLevelName } from '@/lib/env'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

type LogLevel = keyof typeof LEVELS

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[2m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const threshold = LEVELS[logLevelName() as LogLevel] ?? LEVELS.info

function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.includes(' ') ? JSON.stringify(value) : value
  }
  if (value instanceof Error) {
    return JSON.stringify(value.message)
  }
  return JSON.stringify(value) ?? String(value)
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] < threshold) {
    return
  }
  const time = new Date().toISOString().slice(11, 19)
  const entries = Object.entries(fields ?? {}).filter(
    ([, v]) => v !== undefined,
  )
  const tail =
    entries.length > 0
      ? ` ${DIM}${entries.map(([k, v]) => `${k}=${renderValue(v)}`).join(' ')}${RESET}`
      : ''
  const line = `${DIM}${time}${RESET} ${COLOR[level]}${level.padEnd(5)}${RESET} ${DIM}${scope.padEnd(9)}${RESET} ${message}${tail}`
  // Written through the streams directly rather than console, which the linter
  // bans here. Severity routing is the point: a supervisor reads stderr.
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`)
  } else {
    process.stdout.write(`${line}\n`)
  }
}

export interface Logger {
  readonly debug: (message: string, fields?: Record<string, unknown>) => void
  readonly info: (message: string, fields?: Record<string, unknown>) => void
  readonly warn: (message: string, fields?: Record<string, unknown>) => void
  readonly error: (message: string, fields?: Record<string, unknown>) => void
}

export function logger(scope: string): Logger {
  return {
    debug: (message, fields) => emit('debug', scope, message, fields),
    info: (message, fields) => emit('info', scope, message, fields),
    warn: (message, fields) => emit('warn', scope, message, fields),
    error: (message, fields) => emit('error', scope, message, fields),
  }
}

/** Writes an unprefixed line, for streaming agent output that should read as prose. */
export function raw(text: string): void {
  process.stdout.write(text)
}
