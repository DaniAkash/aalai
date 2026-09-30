import { githubEnv } from '@/lib/credentials'
import { execOrThrow } from '@/lib/proc'

/**
 * Runs a gh command with the tokens aalai captured at startup.
 *
 * They are removed from the ambient environment so the agent cannot inherit
 * them, so every command that needs one has to ask for it explicitly.
 */
export async function gh(args: readonly string[]): Promise<string> {
  return execOrThrow(['gh', ...args], { env: githubEnv() })
}

export async function ghJson<T>(args: readonly string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T
}
