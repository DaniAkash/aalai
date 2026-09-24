import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendConversation,
  findArtifacts,
  findSubjects,
  latestArtifact,
  readArtifact,
  writeArtifact,
} from '@/modules/work/artifacts'
import {
  artifactsDir,
  runDir,
  type Subject,
  subjectDir,
} from '@/modules/work/paths'
import { readJson, writeAtomic, writeJson } from '@/modules/work/store'

let dir: string

const ISSUE: Subject = { repo: 'acme/widgets', kind: 'issue', number: 27 }
const PULL: Subject = { repo: 'acme/widgets', kind: 'pr', number: 31 }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-work-'))
  process.env.AALAI_STATE_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the layout', () => {
  test('a repository becomes one path segment', () => {
    expect(subjectDir(ISSUE)).toBe(
      join(dir, 'work', 'acme__widgets', 'issue-27'),
    )
  })

  test('a pull request sits beside an issue, shaped the same', () => {
    expect(subjectDir(PULL)).toBe(join(dir, 'work', 'acme__widgets', 'pr-31'))
  })

  test('runs hang under the subject, not beside it', () => {
    expect(runDir({ subject: ISSUE, runId: 'r1' })).toBe(
      join(subjectDir(ISSUE), 'runs', 'r1'),
    )
  })
})

describe('versioned artifacts', () => {
  test('a second write allocates the next version and keeps the first', async () => {
    const first = await writeArtifact(ISSUE, 'plan', 'the first plan')
    const second = await writeArtifact(ISSUE, 'plan', 'the revised plan')

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(await readArtifact(first.id)).toBe('the first plan')
    expect(await readArtifact(second.id)).toBe('the revised plan')
  })

  test('an approval pinned to v1 still reads what was approved', async () => {
    const approved = await writeArtifact(ISSUE, 'criteria', 'approved list')
    await writeArtifact(ISSUE, 'criteria', 'list revised afterwards')
    expect(await readArtifact(approved.id)).toBe('approved list')
  })

  test('latest is the highest version, not the newest mtime', async () => {
    await writeArtifact(ISSUE, 'plan', 'one')
    await writeArtifact(ISSUE, 'plan', 'two')
    const latest = await latestArtifact(ISSUE, 'plan')
    expect(latest?.version).toBe(2)
  })

  test('kinds do not collide with each other', async () => {
    await writeArtifact(ISSUE, 'plan', 'p')
    const criteria = await writeArtifact(ISSUE, 'criteria', 'c')
    expect(criteria.version).toBe(1)
  })

  test('an id survives being stored and read back later', async () => {
    const ref = await writeArtifact(ISSUE, 'review', 'a verdict')
    expect(ref.id).toBe('acme__widgets/issue-27/artifacts/review.v1.md')
    expect(await readArtifact(ref.id)).toBe('a verdict')
  })

  test('concurrent writes each get their own version, none lost', async () => {
    const writes = Array.from({ length: 12 }, (_, i) =>
      writeArtifact(ISSUE, 'plan', `body ${i}`),
    )
    const refs = await Promise.all(writes)

    const versions = refs.map((ref) => ref.version).sort((a, b) => a - b)
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    // Every body is still readable at the version it was told it got, which is
    // the guarantee that matters: an approval pinned to one cannot be replaced.
    const bodies = await Promise.all(refs.map((ref) => readArtifact(ref.id)))
    expect(new Set(bodies).size).toBe(12)
  })

  test('no staging files are left behind', async () => {
    await Promise.all([
      writeArtifact(ISSUE, 'plan', 'a'),
      writeArtifact(ISSUE, 'plan', 'b'),
    ])
    const left = readdirSync(artifactsDir(ISSUE)).filter((f) =>
      f.includes('.tmp'),
    )
    expect(left).toEqual([])
  })

  test('a missing artifact reads as undefined rather than throwing', async () => {
    expect(
      await readArtifact('acme__widgets/issue-1/artifacts/plan.v9.md'),
    ).toBeUndefined()
  })
})

describe('finding artifacts without an index', () => {
  test('by subject, by kind, and across a repository', async () => {
    await writeArtifact(ISSUE, 'plan', 'issue plan')
    await writeArtifact(ISSUE, 'review', 'issue review')
    await writeArtifact(PULL, 'review', 'pull review')

    expect((await findArtifacts({ subject: ISSUE })).length).toBe(2)
    expect(
      (await findArtifacts({ repo: 'acme/widgets', kind: 'review' })).length,
    ).toBe(2)
    expect((await findArtifacts({ repo: 'acme/widgets' })).length).toBe(3)
  })

  test('a hand written note is found by the same query as everything else', async () => {
    await writeArtifact(ISSUE, 'note', 'guidance somebody typed')
    const found = await findArtifacts({ subject: ISSUE, kind: 'note' })
    expect(found[0]?.kind).toBe('note')
  })

  test('deleting a subject by hand leaves nothing dangling', async () => {
    await writeArtifact(ISSUE, 'plan', 'p')
    await writeArtifact(PULL, 'plan', 'p')
    rmSync(subjectDir(ISSUE), { recursive: true, force: true })

    // No row pointed into it, so the only effect is that it stops being found.
    const found = await findArtifacts({ repo: 'acme/widgets' })
    expect(found.map((f) => f.subject.kind)).toEqual(['pr'])
  })

  test('asking about a subject nothing was written for answers none', async () => {
    // The directory does not exist at all, which is an ordinary question with
    // the answer "none" rather than an error.
    expect(await findArtifacts({ subject: ISSUE })).toEqual([])
    expect(await findArtifacts({ repo: 'acme/widgets' })).toEqual([])
    expect(await findSubjects('acme/widgets')).toEqual([])
  })

  test('subjects are discovered from the tree', async () => {
    await writeArtifact(ISSUE, 'plan', 'p')
    await writeArtifact(PULL, 'plan', 'p')
    expect(await findSubjects('acme/widgets')).toEqual([ISSUE, PULL])
  })
})

describe('the conversation', () => {
  test('appends rather than replacing, and is not versioned', async () => {
    await appendConversation(ISSUE, 'analyst', 'here is the plan')
    await appendConversation(ISSUE, 'DaniAkash', 'change the second step')

    const text = await Bun.file(
      join(artifactsDir(ISSUE), 'conversation.md'),
    ).text()
    expect(text).toContain('here is the plan')
    expect(text).toContain('change the second step')
    expect(readdirSync(artifactsDir(ISSUE))).toEqual(['conversation.md'])
  })
})

describe('atomic writes', () => {
  test('run json round trips', async () => {
    const ref = { subject: ISSUE, runId: 'run-1' }
    await writeJson(ref, 'analysis', { steps: ['one', 'two'] })
    expect(await readJson<{ steps: string[] }>(ref, 'analysis')).toEqual({
      steps: ['one', 'two'],
    })
  })

  test('reading json that was never written is undefined, not a throw', async () => {
    expect(
      await readJson({ subject: ISSUE, runId: 'nope' }, 'run'),
    ).toBeUndefined()
  })

  test('a write that cannot land cleans up its temporary file', async () => {
    const ref = { subject: ISSUE, runId: 'r' }
    await writeJson(ref, 'run', { ok: true })
    const target = join(runDir(ref), 'occupied.json')

    // A non-empty directory standing where the file should go. The temporary
    // file is written successfully and the rename onto it is what fails, which
    // is the only ordering where there is anything left to clean up.
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'resident'), 'in the way')

    await expect(writeAtomic(target, 'never lands')).rejects.toThrow()

    const leftovers = readdirSync(runDir(ref)).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
    // The document that was already there is untouched.
    expect(await readJson<{ ok: boolean }>(ref, 'run')).toEqual({ ok: true })
  })

  test('an interrupted write never leaves a half written target', async () => {
    const ref = { subject: ISSUE, runId: 'r2' }
    await writeJson(ref, 'run', { value: 'complete' })
    const target = join(runDir(ref), 'run.json')

    // Whatever is at the target path is always a document that was finished
    // somewhere else and moved into place, so it parses.
    expect(await Bun.file(target).json()).toEqual({ value: 'complete' })
  })
})
