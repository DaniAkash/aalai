export type {
  GateDecision,
  GateRow,
  RunStatus,
} from '@/modules/db/schema/schema'
export type { RunPolicy } from '@/modules/settings/domains'
export * from './pickerRows'
export * from './queueView'
export * from './triageView'
export * from './workView'

/**
 * Formatting both the terminal and the interface need.
 *
 * Lives beside the event types rather than in `lib`, because `lib` is the
 * factory's own toolbox and reaches for gh, git and the filesystem. This is
 * plain string work with no runtime behind it, which is what makes it safe to
 * ship into a browser bundle.
 */

/**
 * How long something has been waiting, in the largest unit that still says
 * anything.
 *
 * Minutes past an hour stop mattering once a gate has waited a day, and the
 * point is the comparison between rows rather than the duration.
 */
export function waitedFor(openedAt: string, now = Date.now()): string {
  const opened = Date.parse(
    openedAt.includes('T') ? openedAt : `${openedAt.replace(' ', 'T')}Z`,
  )
  if (Number.isNaN(opened)) {
    return ''
  }
  const minutes = Math.max(0, Math.round((now - opened) / 60_000))
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** `owner/repo#42@1790000000000` is how a run names itself. */
const RUN_ID = /^(?<repo>[^#]+)#(?<issue>\d+)@\d+$/

/**
 * Reads the repository and issue back out of a run id.
 *
 * Here rather than beside the resume pass that first needed it, because this is
 * a regex over a string and that module reaches for the database, GitHub and
 * the whole run pipeline. Anything wanting to name a run had to import all of
 * it, which is what put the gate conversation and the run pipeline in a cycle.
 */
export function parseRunId(
  runId: string,
): { repo: string; issueNumber: number } | undefined {
  const match = RUN_ID.exec(runId)
  const repo = match?.groups?.repo
  const issue = match?.groups?.issue
  return repo === undefined || issue === undefined
    ? undefined
    : { repo, issueNumber: Number(issue) }
}

/** `acme/widgets#7@1790…` is an id. This is the part a person reads. */
export function subjectOf(runId: string): string {
  return runId.split('@')[0] ?? runId
}

/**
 * How many times the plan was revised while it was being discussed.
 *
 * Versions keep happening on disk, because that is what makes an approval able
 * to name the exact bytes it approved. What stops is counting them at a person:
 * a negotiation that added one constraint should not present itself as "approve
 * v3", and a version number only means something to somebody when the gate
 * genuinely re-opens later.
 *
 * Empty for a plan nobody has touched, which is the common case and needs no
 * words at all.
 */
export function revisedNote(artifactVersion: string | null): string {
  const version = Number(artifactVersion ?? '1')
  if (!Number.isFinite(version) || version <= 1) {
    return ''
  }
  return version === 2 ? 'revised once' : `revised ${version - 1} times`
}
