import type { Subject } from '@/modules/work/paths'

/**
 * The subject the demo scripts work on.
 *
 * Shared so seeding a gate and parking a run against it cannot disagree about
 * which issue they mean, which they did while each built the identifier itself.
 */
export function demoSubject(): {
  repo: string
  issue: number
  subject: Subject
  runId: string
} {
  const repo = process.env.SEED_REPO ?? 'DaniAkash/aalai-demo'
  const issue = Number(process.env.SEED_ISSUE ?? '412')
  return {
    repo,
    issue,
    subject: { repo, kind: 'issue', number: issue },
    runId: `${repo}#${issue}@1790000000412`,
  }
}
