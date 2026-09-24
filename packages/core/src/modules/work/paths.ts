import { join, resolve, sep } from 'node:path'
import { stateDir } from '@/lib/env'
import type { SubjectKind } from '@/modules/db/schema/schema'

/**
 * Every path shape in one place.
 *
 * A shape duplicated across a writer, a reader and a glob is a shape that will
 * disagree with itself the first time a directory is renamed, and since the
 * filesystem is the artifact index here, a disagreement means a query that
 * silently finds nothing.
 */

export interface Subject {
  /** `owner/repo`, in GitHub's canonical casing. */
  readonly repo: string
  readonly kind: SubjectKind
  readonly number: number
}

export interface RunRef {
  readonly subject: Subject
  readonly runId: string
}

/** A slash would be a directory nobody asked for, so the separator is doubled. */
export function repoSegment(repo: string): string {
  return repo.replace('/', '__')
}

/** `issue-27` or `pr-31`. Identical in shape, because they are handled alike. */
export function subjectSegment(subject: Subject): string {
  return `${subject.kind}-${subject.number}`
}

export function workRoot(): string {
  return join(stateDir(), 'work')
}

function repoDir(repo: string): string {
  return join(workRoot(), repoSegment(repo))
}

export function subjectDir(subject: Subject): string {
  return join(repoDir(subject.repo), subjectSegment(subject))
}

/**
 * Artifacts hang off the subject, not the run.
 *
 * A subject outlives its runs: an issue can be re-run, revised, abandoned and
 * picked up again, and the plan negotiated in the first run is still the plan
 * being argued about in the third.
 */
export function artifactsDir(subject: Subject): string {
  return join(subjectDir(subject), 'artifacts')
}

function runsDir(subject: Subject): string {
  return join(subjectDir(subject), 'runs')
}

/**
 * A run id contains a repository and an issue number, so it carries a slash and
 * a hash and cannot be a directory name as it stands. The subject directory
 * already says which repository and issue this is, so all the segment has to do
 * is tell two runs of the same subject apart.
 */
function runSegment(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function runDir(ref: RunRef): string {
  return join(runsDir(ref.subject), runSegment(ref.runId))
}

/** `plan.v2.md`. The version is in the name because approval pins to one. */
export function artifactFilename(kind: string, version: number): string {
  return `${kind}.v${version}.md`
}

/** A discussion has no versions, so it is one append only file. */
export const CONVERSATION = 'conversation.md'

/**
 * The stable identifier for an artifact: its path relative to the work root.
 *
 * Relative so a row written on one machine still resolves on another, and so
 * moving the state directory does not invalidate every reference in the
 * database.
 */
export function artifactId(subject: Subject, filename: string): string {
  return [
    repoSegment(subject.repo),
    subjectSegment(subject),
    'artifacts',
    filename,
  ].join('/')
}

/**
 * Resolves an artifact id, refusing any that leaves the work directory.
 *
 * An id can reach here from a tool call, which means it can reach here from
 * an issue body by way of an agent. `join` resolves `..`, so without this
 * `../../../../etc/passwd` is a readable file rather than a rejected id.
 */
/** `<repo>/<subject>/artifacts/<name>`, which is the only shape an id may take. */
const ARTIFACT_ID =
  /^(?<repo>[A-Za-z0-9._-]+__[A-Za-z0-9._-]+)\/(?<subject>(?:issue|pr)-\d+)\/artifacts\/(?<file>[a-z][a-z0-9-]*\.v\d+\.md|conversation\.md)$/

export interface ParsedArtifactId {
  readonly repoSegment: string
  readonly subjectSegment: string
  readonly file: string
}

/**
 * Reads an id, or refuses it.
 *
 * Structural rather than prefix based, and deliberately so: a check like
 * `id.startsWith(repo)` passes for `acme__widgets/../other__repo/...`, which
 * then resolves into the other repository. Matching the whole shape leaves no
 * room for a `..` segment to appear anywhere, and it also keeps run internals
 * out of reach, because `runs/<id>/machine.json` is not this shape.
 */
export function parseArtifactId(id: string): ParsedArtifactId | undefined {
  const match = ARTIFACT_ID.exec(id)
  const repo = match?.groups?.repo
  const subject = match?.groups?.subject
  const file = match?.groups?.file
  return repo === undefined || subject === undefined || file === undefined
    ? undefined
    : { repoSegment: repo, subjectSegment: subject, file }
}

export function artifactPath(id: string): string {
  const root = resolve(workRoot())
  const target = resolve(root, ...id.split('/'))
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`artifact id leaves the work directory: ${id}`)
  }
  return target
}
