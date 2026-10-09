import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchDir } from '@/lib/env'
import { exec } from '@/lib/proc'

/**
 * What a branch changed, read from the clone rather than a worktree.
 *
 * A worktree is deleted when its run ends, so reading from one would mean the
 * changes are visible only while the work is in flight, which is exactly when
 * nobody is reviewing them. The clone persists and already has the branch,
 * because pushing is what put it there.
 */

const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

export interface FileChange {
  readonly path: string
  readonly kind: ChangeKind
  readonly additions: number
  readonly deletions: number
}

export interface ChangeSet {
  readonly base: string
  readonly branch: string
  readonly files: readonly FileChange[]
  /** Why there is nothing to show, when there is nothing to show. */
  readonly absent: 'no-branch' | 'no-clone' | null
}

function clonePath(repo: string): string {
  const [owner, name] = repo.split('/')
  return join(workbenchDir(), owner ?? '', name ?? '')
}

/**
 * The branch as git can name it here.
 *
 * A branch that was pushed and whose local ref was pruned still exists as a
 * remote ref, and after a fresh clone only the remote ref exists at all. Trying
 * both is the difference between a diff and an empty pane.
 */
async function resolveRef(
  dir: string,
  branch: string,
): Promise<string | undefined> {
  for (const ref of [branch, `origin/${branch}`]) {
    const found = await exec(
      ['git', 'rev-parse', '--verify', `${ref}^{commit}`],
      {
        cwd: dir,
      },
    )
    if (found.exitCode === 0) {
      return ref
    }
  }
  return undefined
}

const STATUS: Record<string, ChangeKind> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
}

/**
 * The branch this repository actually forks from.
 *
 * Hard coding `main` would show an empty pane for every repository whose
 * default is `master` or anything else, which is a silent wrong answer rather
 * than an error. Falls back to `main` only when the clone cannot say.
 */
async function baseOf(dir: string, given: string | undefined): Promise<string> {
  if (given !== undefined) {
    return given
  }
  const ref = await exec(
    ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: dir },
  )
  return ref.exitCode === 0
    ? ref.stdout.trim().replace(/^origin\//, '')
    : 'main'
}

/**
 * The path a change ends at, and what kind of change it is.
 *
 * A rename is the awkward one. `--name-status` writes `R100<tab>old<tab>new`
 * and `--numstat` writes its counts against the new path, so reading only the
 * first path after the status files a rename under the name it no longer has
 * and the counts never find it.
 */
function statusEntry(line: string): { path: string; kind: ChangeKind } | null {
  const [status, first, second] = line.split('\t')
  if (status === undefined || first === undefined) {
    return null
  }
  const kind = STATUS[status.charAt(0)] ?? 'modified'
  const renamed = status.startsWith('R') || status.startsWith('C')
  const path = renamed ? (second ?? first) : first
  return { path, kind }
}

export async function readChanges(input: {
  repo: string
  branch: string | null
  base?: string
}): Promise<ChangeSet> {
  const branch = input.branch
  const dir = clonePath(input.repo)

  if (!existsSync(join(dir, '.git'))) {
    return {
      base: input.base ?? 'main',
      branch: branch ?? '',
      files: [],
      absent: 'no-clone',
    }
  }
  const base = await baseOf(dir, input.base)
  const empty = { base, branch: branch ?? '', files: [] as FileChange[] }

  if (branch === null) {
    return { ...empty, absent: 'no-branch' }
  }
  const [head, from] = await Promise.all([
    resolveRef(dir, branch),
    resolveRef(dir, base),
  ])
  if (head === undefined || from === undefined) {
    return { ...empty, absent: 'no-branch' }
  }

  // Two passes rather than one: --numstat gives the counts and --name-status
  // gives the kind, and no single format gives both. The range is three dots,
  // so a base that has moved on since the branch was cut does not show as
  // changes this branch made.
  const [counts, kinds] = await Promise.all([
    exec(['git', 'diff', '--numstat', `${from}...${head}`], { cwd: dir }),
    exec(['git', 'diff', '--name-status', `${from}...${head}`], { cwd: dir }),
  ])
  if (counts.exitCode !== 0 || kinds.exitCode !== 0) {
    return { ...empty, absent: 'no-branch' }
  }

  const kindByPath = new Map<string, ChangeKind>()
  for (const line of lines(kinds.stdout)) {
    const entry = statusEntry(line)
    if (entry !== null) {
      kindByPath.set(entry.path, entry.kind)
    }
  }

  const files = lines(counts.stdout).flatMap((line): FileChange[] => {
    const [added, removed, ...rest] = line.split('\t')
    const path = numstatPath(rest)
    if (path === undefined) {
      return []
    }
    return [
      {
        path,
        kind: kindByPath.get(path) ?? 'modified',
        // A binary file reports its counts as a dash rather than a number.
        additions: Number.parseInt(added ?? '', 10) || 0,
        deletions: Number.parseInt(removed ?? '', 10) || 0,
      },
    ]
  })

  return { base, branch, files, absent: null }
}

/** The patch for one file, which is what the pane renders. */
export async function readFilePatch(input: {
  repo: string
  branch: string
  base?: string
  path: string
}): Promise<string | undefined> {
  const dir = clonePath(input.repo)
  if (!existsSync(join(dir, '.git'))) {
    return undefined
  }
  const base = await baseOf(dir, input.base)
  const [head, from] = await Promise.all([
    resolveRef(dir, input.branch),
    resolveRef(dir, base),
  ])
  if (head === undefined || from === undefined) {
    return undefined
  }
  // `--` separates the path from the revision range, so a file named like a
  // branch cannot be read as one.
  const out = await exec(
    ['git', 'diff', `${from}...${head}`, '--', input.path],
    { cwd: dir },
  )
  return out.exitCode === 0 && out.stdout !== '' ? out.stdout : undefined
}

function lines(out: string): string[] {
  return out.split('\n').filter((line) => line !== '')
}

/**
 * The path a numstat row is about.
 *
 * A rename is written either as three fields, the old and the new, or as one
 * field spelling `old => new`. Both mean the file now at the second name.
 */
function numstatPath(
  rest: readonly (string | undefined)[],
): string | undefined {
  const [first, second] = rest
  if (second !== undefined && second !== '') {
    return second
  }
  if (first === undefined) {
    return undefined
  }
  const arrow = first.indexOf(' => ')
  return arrow === -1 ? first : first.slice(arrow + 4).replace(/\}$/, '')
}
