import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Settings that come from the environment rather than from settings.
 *
 * They live apart from config.ts because config is now stored in the database,
 * and the database module needs to know where the state directory is before
 * any config can be read. Keeping these here is what stops that being a cycle.
 */

export function stateDir(): string {
  return process.env.AALAI_STATE_DIR ?? join(homedir(), '.aalai')
}

/** Log verbosity, from the environment rather than from settings. */
export function logLevelName(): string {
  return process.env.AALAI_LOG_LEVEL ?? 'info'
}

/** Set by the evals, which exercise the pipeline without an HTTP surface. */
export function serverDisabled(): boolean {
  return process.env.AALAI_NO_SERVER === '1'
}

export function workbenchDir(): string {
  return process.env.AALAI_WORKBENCH_DIR ?? join(homedir(), 'workbench')
}

/**
 * An explicit config file, when one is named.
 *
 * Settings live in the database, but pointing this at a checked in file stays
 * a legitimate way to run headless where the settings are part of a deployment.
 */
export function configOverride(): string | undefined {
  return process.env.AALAI_CONFIG
}

/**
 * Who a decision is recorded against when a person answers from a terminal.
 *
 * The audit field on a gate, not an identity: it says which account was at the
 * keyboard, and it stays local to this machine's database.
 */
export function localUser(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'maintainer'
}
