import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { grantToolAccess, revokeToolAccess } from '@/modules/tools/context'
import { startServer } from '@/server/serve'

/**
 * A station reporting a long step, for watching the interface while it does.
 *
 * The acceptance test here is that a step taking minutes shows a number that
 * keeps changing for all of them, and no fixture can show that. So this is the
 * api server the interface already talks to, with a station driving the real
 * tools over the real protocol in the same process. Everything between the
 * tool call and the pixel is the shipping path: the event bus, the stream, the
 * store, the render. Only the agent's judgement is stood in for, which is the
 * part not under test.
 *
 * Run it with the vite dev server up, which proxies the api to this port.
 * Arguments: beat in milliseconds, the subject as `owner/name#number`, the
 * port. The subject matters: a work list row only shows progress for a run the
 * factory considers running, so driving an offered one proves the thread and
 * nothing about the list.
 */

const [beatArg, subjectArg, portArg] = Bun.argv.slice(2)
const BEAT = Number(beatArg ?? 2500)
const PORT = Number(portArg ?? 4173)
const [repo = 'DaniAkash/aalai-demo', issue = '61'] = (
  subjectArg ?? 'DaniAkash/aalai-demo#61'
).split('#')
const SUBJECT = { repo, kind: 'issue' as const, number: Number(issue) }

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const say = (line: string) => process.stdout.write(`${line}\n`)

const handle = startServer(PORT)
if (handle === null) {
  throw new Error(`port ${PORT} is busy, stop the sidecar first`)
}

const runId = `${SUBJECT.repo}#${SUBJECT.number}@${Date.now()}`
const { token } = grantToolAccess({
  runId,
  title: 'formatBytes is off by one at the unit boundary',
  subject: SUBJECT,
  run: { subject: SUBJECT, runId },
  station: 'implementer',
  worktreePath: process.cwd(),
})

const client = new Client({ name: 'drive-live-step', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/api/mcp/${token}`),
  ),
)

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) {
    throw new Error(`${name} refused: ${JSON.stringify(result.content)}`)
  }
}

say(`serving on ${PORT}, run ${runId}`)
say('step 1 of the plan: the quick one')
await call('start_step', {
  step_index: 0,
  label: 'Correct the comparison in the unit loop',
})
await sleep(BEAT)
await call('finish_step', {
  step_index: 0,
  summary: 'The loop now divides while the value is at or above the unit.',
  files: [],
})

say('step 2 of the plan: the slow one, reporting as it goes')
await call('start_step', {
  step_index: 1,
  label: 'Round to one decimal rather than truncating',
})
for (const done of [4, 11, 19, 28, 37, 48, 56, 61, 68]) {
  await sleep(BEAT)
  await call('report_progress', {
    step_index: 1,
    label: 'bun test',
    unit: 'files',
    done,
    total: 68,
  })
  say(`  ${done} of 68 files`)
}

say('holding here so the banner stays up')
await sleep(600_000)

await client.close()
revokeToolAccess(token)
process.exit(0)
