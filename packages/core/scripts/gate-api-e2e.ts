/**
 * The gate over HTTP, plus the cross process case the whole design turns on.
 *
 * Drives a real server over the network and a real second process, which is
 * what the unit tests cannot cover: an in-process answer is served by the bus
 * and proves nothing about the mechanism a terminal actually depends on.
 *
 * Run from `packages/core` with `bun run scripts/gate-api-e2e.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor, fromPromise, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { listGates, openGate, readGate } from '@/modules/gates'
import { writeArtifact } from '@/modules/work/artifacts'
import { appendEntry } from '@/modules/work/conversation'
import { provideRunDeps, releaseRunDeps } from '@/run/machines/deps'
import { gateKeeper } from '@/run/machines/gateActor'
import { startServer, stopServer } from '@/server/serve'
import { check, finish, scenario } from './e2e-report'

const dir = mkdtempSync(join(tmpdir(), 'aalai-api-e2e-'))
process.env.AALAI_STATE_DIR = dir

const TOKEN = 'e2e-token'

const handle = startServer(0, TOKEN)
if (handle === null) {
  throw new Error('the server did not bind')
}
const base = `http://127.0.0.1:${handle.port}`

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
  }
}

const { sqlite } = openDb(join(dir, 'aalai.sqlite'))
const SUBJECT = { repo: 'acme/widgets', kind: 'issue' as const, number: 7 }
const RUN = 'acme/widgets#7@1790000000000'
await writeArtifact(SUBJECT, 'plan', '# Plan\n\n1. Add the guard\n')

scenario('1. The surface is closed without the token')
{
  const health = await fetch(`${base}/api/health`)
  check('health needs no token', health.status === 200)
  const naked = await fetch(`${base}/api/gates`)
  check('everything else does', naked.status === 401)
}

scenario('2. A gate and its artifact come back together')
const gate = openGate(sqlite, {
  runId: RUN,
  kind: 'plan',
  artifactPath: 'acme__widgets/issue-7/artifacts/plan.v1.md',
  artifactVersion: '1',
})
{
  const list = await call('/api/gates')
  const gates = (list.body as { gates: { id: string }[] }).gates
  check(
    'the open gate is listed',
    gates.some((row) => row.id === gate),
  )

  // The id carries a slash, a hash and an at sign, so the client encodes it.
  const one = await call(`/api/gates/${encodeURIComponent(gate)}`)
  check('an encoded id resolves', one.status === 200)
  const detail = one.body as { gate: { id: string }; artifact: string | null }
  check('it is the right gate', detail.gate.id === gate)
  check(
    'the artifact a person reads comes with it',
    detail.artifact?.includes('Add the guard') === true,
  )
}

scenario('3. A malformed answer is refused before it reaches the database')
{
  const bad = await call(`/api/gates/${encodeURIComponent(gate)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'maybe', answeredBy: 'someone' }),
  })
  check('rejected as a bad request', bad.status === 400)
  check('nothing was recorded', readGate(sqlite, gate)?.status === 'open')
}

scenario('4. Answering over HTTP, then answering again')
{
  const first = await call(`/api/gates/${encodeURIComponent(gate)}/answer`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approved',
      answeredBy: 'maintainer',
      answeredOn: 'app',
    }),
  })
  check('accepted', first.status === 200)
  check('recorded', readGate(sqlite, gate)?.decision === 'approved')

  const second = await call(`/api/gates/${encodeURIComponent(gate)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'rejected', answeredBy: 'someone else' }),
  })
  check('a second answer conflicts rather than faulting', second.status === 409)
  check(
    'the first decision still stands',
    readGate(sqlite, gate)?.decision === 'approved',
  )

  const missing = await call('/api/gates/nothing-here')
  check('an unknown gate is not found', missing.status === 404)
}

scenario('5. Settings round trip, and a partial patch leaves the rest alone')
{
  const before = await call('/api/settings')
  const original = (before.body as { settings: { pollSeconds: number } })
    .settings
  const patched = await call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ defaultPolicy: 'plan_gate' }),
  })
  const next = (
    patched.body as {
      settings: { defaultPolicy: string; pollSeconds: number }
    }
  ).settings
  check('the change took', next.defaultPolicy === 'plan_gate')
  check(
    'an untouched field survived',
    next.pollSeconds === original.pollSeconds,
  )

  const reread = await call('/api/settings')
  check(
    'and it persisted',
    (reread.body as { settings: { defaultPolicy: string } }).settings
      .defaultPolicy === 'plan_gate',
  )

  const rejected = await call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ defaultPolicy: 'whatever' }),
  })
  check('an unknown policy is refused', rejected.status === 400)
}

scenario('6. A per repository policy survives the round trip')
{
  await call('/api/repos', {
    method: 'POST',
    body: JSON.stringify({ repo: 'acme/widgets' }),
  })
  const bad = await call('/api/repos', {
    method: 'POST',
    body: JSON.stringify({ repo: 'not a repo' }),
  })
  check('a malformed add is refused by the validator', bad.status === 400)

  await call('/api/repos/acme/widgets', {
    method: 'PATCH',
    body: JSON.stringify({ policy: 'plan_gate', requireLabel: 'aalai' }),
  })
  const listed = await call('/api/repos')
  const repos = (
    listed.body as {
      repos: { repo: string; policy?: string; requireLabel?: string }[]
    }
  ).repos
  const widgets = repos.find((row) => row.repo === 'acme/widgets')
  check(
    'the policy came back from the database',
    widgets?.policy === 'plan_gate',
  )
  check('so did the label', widgets?.requireLabel === 'aalai')

  await call('/api/repos/acme/widgets', {
    method: 'PATCH',
    body: JSON.stringify({ requireLabel: null }),
  })
  const after = await call('/api/repos')
  const cleared = (
    after.body as {
      repos: { repo: string; policy?: string; requireLabel?: string }[]
    }
  ).repos.find((row) => row.repo === 'acme/widgets')
  check('clearing the label leaves the policy', cleared?.policy === 'plan_gate')
  check('and the label is gone', cleared?.requireLabel === undefined)

  const unwatched = await call('/api/repos/nobody/nothing', {
    method: 'PATCH',
    body: JSON.stringify({ policy: 'triage' }),
  })
  check(
    'patching an unwatched repository is not found',
    unwatched.status === 404,
  )
}

scenario('7. A terminal in another process answers a parked run')
{
  const parked = openGate(sqlite, {
    runId: 'acme/widgets#9@1',
    kind: 'plan',
    artifactVersion: '1',
  })
  // A real second process, because an answer from this one would be delivered
  // by the in-process bus and would prove nothing about what a terminal does.
  const answering = Bun.spawn(
    ['bun', 'run', 'src/index.ts', 'approve', parked],
    {
      env: { ...process.env, AALAI_STATE_DIR: dir, AALAI_NO_SERVER: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const code = await answering.exited
  if (code !== 0) {
    // What it said, because "exited 1" alone sends the next person hunting
    // through the CLI rather than reading the one line that explains it.
    process.stdout.write(
      `        out: ${(await new Response(answering.stdout).text()).trim()}\n`,
    )
  }
  check('the terminal exits cleanly', code === 0)
  check(
    'the answer is visible here',
    readGate(sqlite, parked)?.decision === 'approved',
  )
  check(
    'and it says it came from a terminal',
    readGate(sqlite, parked)?.answeredOn === 'cli',
  )
}

scenario('8. A parked machine resumes when a terminal answers it')
{
  const RESUME_RUN = 'acme/widgets#11@1'
  const subject = { repo: 'acme/widgets', kind: 'issue' as const, number: 11 }
  await writeArtifact(subject, 'plan', '# Plan\n\n1. The thing\n')
  provideRunDeps(RESUME_RUN, {
    db: sqlite,
    run: { subject, runId: RESUME_RUN },
    repo: subject.repo,
  } as never)

  const machine = setup({ actors: { gateKeeper } }).createMachine({
    initial: 'parked',
    states: {
      parked: {
        invoke: {
          src: 'gateKeeper',
          input: {
            runId: RESUME_RUN,
            repo: subject.repo,
            issue: 11,
            kind: 'plan',
          },
        },
        on: { GATE_ANSWERED: 'moving' },
      },
      moving: { type: 'final' },
    },
  })
  const actor = createActor(machine).start()
  await waitFor(
    actor,
    () => listGates(sqlite, { runId: RESUME_RUN, status: 'open' }).length > 0,
    { timeout: 5000 },
  )
  const [parked] = listGates(sqlite, { runId: RESUME_RUN, status: 'open' })
  check('the run parked and opened a gate', parked !== undefined)

  const answering = Bun.spawn(
    ['bun', 'run', 'src/index.ts', 'approve', parked?.id ?? ''],
    {
      env: { ...process.env, AALAI_STATE_DIR: dir, AALAI_NO_SERVER: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  check('the terminal approved it', (await answering.exited) === 0)

  const settled = await waitFor(actor, (state) => state.status === 'done', {
    timeout: 15_000,
  })
  check('the run resumed past the gate', settled.value === 'moving')
  actor.stop()
  releaseRunDeps(RESUME_RUN)
}

scenario('7. The discussion behind a gate is readable over HTTP')
{
  const THREAD_RUN = 'acme/widgets#21@1790000000021'
  const subject = { repo: 'acme/widgets', kind: 'issue' as const, number: 21 }
  const artifact = await writeArtifact(
    subject,
    'plan',
    '# Plan\n\n1. Stream it\n',
  )
  const openedId = openGate(sqlite, {
    runId: THREAD_RUN,
    kind: 'plan',
    artifactPath: artifact.id,
    artifactVersion: String(artifact.version),
  })

  const empty = await call(`/api/gates/${encodeURIComponent(openedId)}/thread`)
  check(
    'an untouched gate has an empty thread rather than a 404',
    empty.status === 200,
  )
  const emptyBody = empty.body as { entries: unknown[]; state: string }
  check('nothing has been said yet', emptyBody.entries.length === 0)
  check('and nothing is mid answer', emptyBody.state === 'idle')

  await appendEntry(subject, {
    author: 'analyst',
    role: 'station',
    body: 'Plan recorded.',
  })
  await appendEntry(subject, {
    author: 'dani',
    role: 'maintainer',
    // A heading, which is what broke the old delimiter.
    body: '## Why\n\nWhy stream rather than buffer?',
  })

  const full = await call(`/api/gates/${encodeURIComponent(openedId)}/thread`)
  const body = full.body as {
    entries: { author: string; role: string; body: string }[]
    state: string
  }
  check('both entries came back', body.entries.length === 2)
  check('in the order they were said', body.entries[0]?.author === 'analyst')
  check(
    'the maintainer entry carries its role',
    body.entries[1]?.role === 'maintainer',
  )
  check(
    'a heading in a reply did not split it into two entries',
    body.entries[1]?.body.includes('## Why') === true,
  )

  const missing = await call('/api/gates/nope/thread')
  check('an unknown gate is a 404, not an empty thread', missing.status === 404)
}

scenario(
  '8. A reply over HTTP reaches a parked machine and leaves the gate open',
)
{
  const REPLY_RUN = 'acme/widgets#22@1790000000022'
  const subject = { repo: 'acme/widgets', kind: 'issue' as const, number: 22 }
  await writeArtifact(subject, 'plan', '# Plan\n\n1. Buffer it\n')

  const asked: string[] = []
  const machine = setup({
    actors: {
      gateKeeper,
      replier: fromPromise(
        async ({ input }: { input: { question: string } }) => {
          asked.push(input.question)
          // What a real turn does to answer: append, which is also what stops
          // the reply being pending.
          await appendEntry(subject, {
            author: 'analyst',
            role: 'station',
            body: 'because a 2GB dump does not fit in memory',
          })
          return {}
        },
      ),
    },
  }).createMachine({
    id: 'replying',
    initial: 'gatingPlan',
    states: {
      gatingPlan: {
        initial: 'waiting',
        invoke: {
          src: 'gateKeeper',
          input: {
            runId: REPLY_RUN,
            repo: subject.repo,
            issue: 22,
            kind: 'plan',
            pollMs: 50,
          },
        },
        states: {
          waiting: { on: { REPLY_RECEIVED: 'answering' } },
          answering: {
            invoke: {
              src: 'replier',
              input: ({ event }) => ({
                question: String(
                  (event as { question?: string }).question ?? '',
                ),
              }),
              onDone: 'waiting',
              onError: 'waiting',
            },
          },
        },
        on: { GATE_ANSWERED: 'settled' },
      },
      settled: { type: 'final' },
    },
  })

  provideRunDeps(REPLY_RUN, {
    db: sqlite,
    run: { subject, runId: REPLY_RUN },
    repo: subject.repo,
  } as never)
  const actor = createActor(machine).start()
  await waitFor(
    actor,
    () => listGates(sqlite, { runId: REPLY_RUN, status: 'open' }).length > 0,
    { timeout: 5000 },
  )
  const [parked] = listGates(sqlite, { runId: REPLY_RUN, status: 'open' })
  const gateId = parked?.id ?? ''
  check('the run parked on a plan gate', gateId !== '')

  const posted = await call(`/api/gates/${encodeURIComponent(gateId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({
      body: 'Why buffer rather than stream?',
      author: 'dani',
    }),
  })
  check('the reply was accepted', posted.status === 200)

  await waitFor(actor, () => asked.length === 1, { timeout: 8000 })
  check('it woke a turn in the parked machine', asked.length === 1)
  check(
    'and the turn was given the question',
    asked[0]?.includes('Why buffer') === true,
  )

  const still = readGate(sqlite, gateId)
  check('the gate is still open', still?.status === 'open')
  check('nothing was decided', still?.decision === null)

  const thread = await call(`/api/gates/${encodeURIComponent(gateId)}/thread`)
  const entries = (thread.body as { entries: { role: string }[] }).entries
  check('the thread holds the question and the answer', entries.length === 2)
  check('the maintainer asked first', entries[0]?.role === 'maintainer')
  check('and a station answered', entries[1]?.role === 'station')

  // The maintainer can still decide, which is the point of the gate staying open.
  const approved = await call(
    `/api/gates/${encodeURIComponent(gateId)}/answer`,
    {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', answeredBy: 'dani' }),
    },
  )
  check(
    'the gate can still be approved after a discussion',
    approved.status === 200,
  )
  const settled = await waitFor(actor, (state) => state.status === 'done', {
    timeout: 8000,
  })
  check('and the run moved on', settled.value === 'settled')
  actor.stop()
  releaseRunDeps(REPLY_RUN)

  const refused = await call(`/api/gates/${encodeURIComponent(gateId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ body: 'too late', author: 'dani' }),
  })
  check(
    'a reply to an answered gate is refused, not appended',
    refused.status === 409,
  )
}

scenario('9. A reply that cannot be stored is refused rather than half written')
{
  const GUARD_RUN = 'acme/widgets#23@1790000000023'
  const subject = { repo: 'acme/widgets', kind: 'issue' as const, number: 23 }
  const artifact = await writeArtifact(
    subject,
    'plan',
    '# Plan\n\n1. Guard it\n',
  )
  const gid = openGate(sqlite, {
    runId: GUARD_RUN,
    kind: 'plan',
    artifactPath: artifact.id,
    artifactVersion: String(artifact.version),
  })
  const path = `/api/gates/${encodeURIComponent(gid)}/reply`

  const blank = await call(path, {
    method: 'POST',
    body: JSON.stringify({ body: '   \n  ', author: 'dani' }),
  })
  check('a body of whitespace is refused', blank.status === 400)

  const multiline = await call(path, {
    method: 'POST',
    body: JSON.stringify({ body: 'fine', author: 'da\nni' }),
  })
  check('an author spanning two lines is refused', multiline.status === 400)

  const after = await call(`/api/gates/${encodeURIComponent(gid)}/thread`)
  const entries = (after.body as { entries: unknown[] }).entries
  check('and neither reached the record', entries.length === 0)

  // A body that is only padded is kept, trimmed, because the person did say it.
  const padded = await call(path, {
    method: 'POST',
    body: JSON.stringify({ body: '  a real question  ', author: '  dani  ' }),
  })
  check('a padded body is accepted', padded.status === 200)
  const thread = await call(`/api/gates/${encodeURIComponent(gid)}/thread`)
  const kept = (thread.body as { entries: { body: string; author: string }[] })
    .entries
  check('trimmed on the way in', kept[0]?.body === 'a real question')
  check('and so is the author', kept[0]?.author === 'dani')
}

scenario('10. A stale question is not adopted by a later gate')
{
  const STALE_RUN = 'acme/widgets#24@1790000000024'
  const subject = { repo: 'acme/widgets', kind: 'issue' as const, number: 24 }
  await writeArtifact(subject, 'plan', '# Plan\n\n1. One\n')
  await appendEntry(subject, {
    author: 'dani',
    role: 'maintainer',
    body: 'asked while an earlier gate was open',
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))

  const asked: string[] = []
  const machine = setup({
    actors: {
      gateKeeper,
      replier: fromPromise(
        async ({ input }: { input: { question: string } }) => {
          asked.push(input.question)
          return {}
        },
      ),
    },
  }).createMachine({
    id: 'stale',
    initial: 'gatingPlan',
    states: {
      gatingPlan: {
        initial: 'waiting',
        invoke: {
          src: 'gateKeeper',
          input: {
            runId: STALE_RUN,
            repo: subject.repo,
            issue: 24,
            kind: 'plan',
            pollMs: 50,
          },
        },
        states: {
          waiting: { on: { REPLY_RECEIVED: 'answering' } },
          answering: {
            invoke: {
              src: 'replier',
              input: ({ event }) => ({
                question: String(
                  (event as { question?: string }).question ?? '',
                ),
              }),
              onDone: 'waiting',
              onError: 'waiting',
            },
          },
        },
        on: { GATE_ANSWERED: 'settled' },
      },
      settled: { type: 'final' },
    },
  })

  provideRunDeps(STALE_RUN, {
    db: sqlite,
    run: { subject, runId: STALE_RUN },
    repo: subject.repo,
  } as never)
  const actor = createActor(machine).start()
  await waitFor(
    actor,
    () => listGates(sqlite, { runId: STALE_RUN, status: 'open' }).length > 0,
    { timeout: 5000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    'a question from before this gate opened is left alone',
    asked.length === 0,
  )
  actor.stop()
  releaseRunDeps(STALE_RUN)
}

stopServer()
sqlite.close()
rmSync(dir, { recursive: true, force: true })
finish()
