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
import { createActor, setup, waitFor } from 'xstate'
import { openDb } from '@/modules/db/db'
import { listGates, openGate, readGate } from '@/modules/gates'
import { writeArtifact } from '@/modules/work/artifacts'
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
  check('the terminal exits cleanly', (await answering.exited) === 0)
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

stopServer()
sqlite.close()
rmSync(dir, { recursive: true, force: true })
finish()
