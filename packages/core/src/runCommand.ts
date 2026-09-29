import type { Config } from '@/config'
import { serverDisabled } from '@/lib/env'
import { getIssue } from '@/lib/gh'
import { logger } from '@/lib/log'
import { runIssue } from '@/run/pipeline'
import { startApi, stopServer } from '@/server/serve'
import { screenIssue } from '@/watch/intake'
import { claimRun, completeRun, openState } from '@/watch/state'

const log = logger('aalai')

/** Manual trigger. Bypasses the cursor but still claims, so a demo cannot double-run. */
export async function runOne(
  config: Config,
  repo: string,
  issueNumber: number,
  opts?: { port?: string | undefined; token?: string | undefined },
): Promise<void> {
  const db = openState()
  if (!serverDisabled()) {
    startApi({
      defaultPort: config.uiPort,
      port: opts?.port,
      token: opts?.token,
    })
  }
  const issue = await getIssue(repo, issueNumber)
  const screening = screenIssue(issue, {
    trustedAuthorsOnly: config.trustedAuthorsOnly,
    requireLabel: config.requireLabel,
  })
  if (!screening.accepted) {
    log.error('issue rejected by intake policy', { reason: screening.reason })
    process.exitCode = 1
    db.close()
    return
  }
  const lease = claimRun(
    db,
    repo,
    issueNumber,
    config.staleClaimMinutes * 60_000,
  )
  if (lease === null) {
    log.error('already run; use `aalai forget <repo> <issue>` to retry', {
      repo,
      issue: issueNumber,
    })
    process.exitCode = 1
    db.close()
    return
  }
  const result = await runIssue(repo, issue, config)
  completeRun(db, repo, issueNumber, {
    status: result.status,
    branch: result.branch,
    prUrl: result.prUrl,
    error: result.error,
    lease,
  })
  log.info('done', {
    status: result.status,
    pr: result.prUrl,
    error: result.error,
  })
  if (result.status === 'failed') {
    process.exitCode = 1
  }
  db.close()
  // The tool surface outlives the run otherwise, and a listening socket keeps
  // the process alive long after it has finished. A command that has said
  // "done" and then sits there is indistinguishable from one that hung.
  stopServer()
}
