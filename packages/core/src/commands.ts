import { loadConfig } from '@/config'
import { githubEnv } from '@/lib/credentials'
import { stateDir } from '@/lib/env'
import { authenticatedLogin } from '@/lib/gh'
import { bad, heading, link, note, ok, table } from '@/lib/output'
import { exec } from '@/lib/proc'
import { listRuns, openState } from '@/watch/state'

/** The pull request column, labelled by its number so the cell stays narrow. */
function prCell(url: string | null): string {
  if (url === null) {
    return ''
  }
  const number = url.split('/').pop()
  return link(number === undefined ? 'open' : `#${number}`, url)
}

export function showStatus(): void {
  const db = openState()
  const runs = listRuns(db)
  if (runs.length === 0) {
    note('no runs recorded yet')
    db.close()
    return
  }
  heading('runs')
  table(
    ['repo', 'issue', 'status', 'pull request', 'error'],
    runs.map((run) => [
      run.repo,
      `#${run.issue}`,
      run.status,
      prCell(run.pr_url),
      run.error ?? '',
    ]),
  )
  db.close()
}

export async function doctor(): Promise<void> {
  let healthy = true
  heading('aalai doctor')

  const gh = await exec(['gh', 'auth', 'status'], { env: githubEnv() })
  if (gh.exitCode === 0) {
    ok('gh authenticated', `as ${await authenticatedLogin()}`)
  } else {
    healthy = false
    bad('gh is not authenticated', 'run `gh auth login`')
  }

  const git = await exec(['git', '--version'])
  if (git.exitCode === 0) {
    ok('git present')
  } else {
    healthy = false
    bad('git missing')
  }

  try {
    const config = await loadConfig()
    ok(
      'config valid',
      `${config.watch.length} repos, ${Object.values(config.agents).join(', ')}`,
    )
  } catch (error) {
    healthy = false
    bad(
      'config problem',
      error instanceof Error ? error.message : String(error),
    )
  }

  note('state directory', stateDir())
  if (!healthy) {
    process.exitCode = 1
  }
}
