import { appendFile, link, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubjectKind } from '@/modules/db/schema/schema'
import {
  artifactFilename,
  artifactId,
  artifactPath,
  artifactsDir,
  CONVERSATION,
  repoSegment,
  type Subject,
  subjectSegment,
  workRoot,
} from './paths'
import { stagingPath } from './store'

/**
 * Artifacts are versioned files, and the filesystem is their index.
 *
 * An index table would be a cache that can lie: a file added, renamed or
 * deleted out of band leaves a row pointing at nothing, and then two sources
 * disagree about what exists. Every query the brain needs falls out of a glob
 * over paths that are already fully predictable.
 */

export interface ArtifactRef {
  /** Path relative to the work root. Stable enough to store in a row. */
  readonly id: string
  readonly subject: Subject
  readonly kind: string
  readonly version: number
  /** Absolute path, for reading. Derived, never stored. */
  readonly path: string
}

const VERSIONED = /^(?<kind>[a-z][a-z0-9-]*)\.v(?<version>\d+)\.md$/

function parseFilename(
  subject: Subject,
  filename: string,
): ArtifactRef | undefined {
  const match = VERSIONED.exec(filename)
  const kind = match?.groups?.kind
  const version = match?.groups?.version
  if (kind === undefined || version === undefined) {
    return undefined
  }
  return {
    id: artifactId(subject, filename),
    subject,
    kind,
    version: Number(version),
    path: join(artifactsDir(subject), filename),
  }
}

/**
 * Scanning a directory that does not exist yet.
 *
 * A subject nothing has been written for has no artifacts directory, and
 * asking about one is an ordinary question with the answer "none" rather than
 * an error. Glob throws ENOENT on a missing cwd, so that becomes the empty
 * answer here instead of at every call site.
 */
async function* scanOrEmpty(
  glob: Bun.Glob,
  cwd: string,
  onlyFiles: boolean,
): AsyncGenerator<string> {
  try {
    yield* glob.scan({ cwd, onlyFiles })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function listVersions(
  subject: Subject,
  kind: string,
): Promise<ArtifactRef[]> {
  const dir = artifactsDir(subject)
  const glob = new Bun.Glob(`${kind}.v*.md`)
  const refs: ArtifactRef[] = []
  for await (const filename of scanOrEmpty(glob, dir, true)) {
    const ref = parseFilename(subject, filename)
    if (ref !== undefined) {
      refs.push(ref)
    }
  }
  return refs.sort((a, b) => a.version - b.version)
}

/**
 * Writes the next version of an artifact. Never overwrites.
 *
 * Approval pins to a version: the implementer is graded against the criteria
 * that were approved, not against whatever replaced them. Keeping the previous
 * bytes is what turns "is this approval still current" into a real check.
 */
export async function writeArtifact(
  subject: Subject,
  kind: string,
  content: string,
): Promise<ArtifactRef> {
  const dir = artifactsDir(subject)
  await mkdir(dir, { recursive: true })

  // Staged first, then linked into place. link() fails if the name is taken,
  // which makes claiming a version one atomic step rather than a check and a
  // write with a gap between them: two writers scanning at the same moment
  // would both pick the same next number, and rename would silently replace
  // the first document.
  const staging = stagingPath(join(dir, `${kind}.pending`))
  await Bun.write(staging, content)

  try {
    let version = ((await listVersions(subject, kind)).at(-1)?.version ?? 0) + 1
    for (;;) {
      const filename = artifactFilename(kind, version)
      try {
        await link(staging, join(dir, filename))
        return {
          id: artifactId(subject, filename),
          subject,
          kind,
          version,
          path: join(dir, filename),
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
        version += 1
      }
    }
  } finally {
    await rm(staging, { force: true })
  }
}

export async function readArtifact(id: string): Promise<string | undefined> {
  const file = Bun.file(artifactPath(id))
  return (await file.exists()) ? await file.text() : undefined
}

export async function latestArtifact(
  subject: Subject,
  kind: string,
): Promise<ArtifactRef | undefined> {
  return (await listVersions(subject, kind)).at(-1)
}

export interface ArtifactQuery {
  readonly repo?: string
  readonly subject?: Subject
  readonly kind?: string
  readonly limit?: number
}

const SUBJECT_SEGMENT = /^(?<kind>issue|pr)-(?<number>\d+)$/

function subjectFromPath(repo: string, segment: string): Subject | undefined {
  const match = SUBJECT_SEGMENT.exec(segment)
  const kind = match?.groups?.kind
  const number = match?.groups?.number
  if (kind === undefined || number === undefined) {
    return undefined
  }
  return { repo, kind: kind as SubjectKind, number: Number(number) }
}

/**
 * Finds artifacts by globbing, which is the whole index.
 *
 * Measured against a synthetic tree of 8,397 artifacts, a full scan takes tens
 * of milliseconds and a scoped one a fraction of that. A table would buy
 * nothing against those numbers and would need keeping in sync.
 */
function refFromRelativePath(relative: string): ArtifactRef | undefined {
  const [repoSeg, subjectSeg, , filename] = relative.split('/')
  if (
    repoSeg === undefined ||
    subjectSeg === undefined ||
    filename === undefined
  ) {
    return undefined
  }
  const subject = subjectFromPath(repoSeg.replace('__', '/'), subjectSeg)
  return subject === undefined ? undefined : parseFilename(subject, filename)
}

async function scanRepos(
  repo: string | undefined,
  kind: string,
): Promise<ArtifactRef[]> {
  const repoPart = repo === undefined ? '*' : repoSegment(repo)
  const glob = new Bun.Glob(`${repoPart}/*/artifacts/${kind}.v*.md`)
  const refs: ArtifactRef[] = []
  for await (const relative of scanOrEmpty(glob, workRoot(), true)) {
    const ref = refFromRelativePath(relative)
    if (ref !== undefined) {
      refs.push(ref)
    }
  }
  return refs
}

export async function findArtifacts(
  query: ArtifactQuery = {},
): Promise<ArtifactRef[]> {
  const kind = query.kind ?? '*'
  const refs =
    query.subject === undefined
      ? await scanRepos(query.repo, kind)
      : await listVersions(query.subject, kind)

  refs.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
  return query.limit === undefined ? refs : refs.slice(0, query.limit)
}

/**
 * Appends to the subject's conversation.
 *
 * Unversioned because a discussion has no versions, and append only because
 * rewriting what was said is how a record stops being one.
 */
export async function appendConversation(
  subject: Subject,
  author: string,
  body: string,
): Promise<string> {
  const dir = artifactsDir(subject)
  await mkdir(dir, { recursive: true })
  const path = join(dir, CONVERSATION)
  const entry = `\n## ${author} · ${new Date().toISOString()}\n\n${body.trim()}\n`
  await appendFile(path, entry, 'utf8')
  return path
}

/** Every subject with artifacts under one repository. */
export async function findSubjects(repo: string): Promise<Subject[]> {
  const glob = new Bun.Glob(`${repoSegment(repo)}/*/artifacts`)
  const subjects: Subject[] = []
  for await (const relative of scanOrEmpty(glob, workRoot(), false)) {
    const segment = relative.split('/')[1]
    const subject =
      segment === undefined ? undefined : subjectFromPath(repo, segment)
    if (subject !== undefined) {
      subjects.push(subject)
    }
  }
  return subjects.sort((a, b) =>
    subjectSegment(a).localeCompare(subjectSegment(b)),
  )
}
