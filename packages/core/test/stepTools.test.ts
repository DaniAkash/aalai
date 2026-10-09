import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { replay, resetBus } from '@/events/bus'
import type { RunEvent } from '@/events/events.types'
import {
  grantToolAccess,
  revokeToolAccess,
  type ToolContext,
} from '@/modules/tools/context'
import { STATION_TOOLS } from '@/modules/tools/registry'
import type { Subject } from '@/modules/work/paths'
import { app } from '@/server/app'

let dir: string
let server: ReturnType<typeof Bun.serve>
let base: string

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 27 }
const RUN_ID = 'acme/widgets#27@1790000000027'

function contextFor(
  station: ToolContext['station'],
): Omit<
  ToolContext,
  'written' | 'queued' | 'recorded' | 'answered' | 'context'
> {
  return {
    runId: RUN_ID,
    title: 'formatBytes gives the wrong number',
    subject: SUBJECT,
    run: { subject: SUBJECT, runId: RUN_ID },
    station,
    worktreePath: '/tmp/worktree',
  }
}

/**
 * Grants are module state and the suite asserts on how many are live, so a
 * test that leaves one behind fails a different file. Tracked here and revoked
 * after each test rather than relying on every call site remembering.
 */
const granted: string[] = []

function tokenFor(station: ToolContext['station']): string {
  const { token } = grantToolAccess(contextFor(station))
  granted.push(token)
  return token
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/${token}`)),
  )
  return client
}

function stepEvents(): RunEvent[] {
  return replay(RUN_ID).filter((event) => event.type.startsWith('step.'))
}

beforeEach(() => {
  // The bus is module state and keeps a ring buffer per run, so without this
  // each test reads the events the previous one emitted.
  resetBus()
  dir = mkdtempSync(join(tmpdir(), 'aalai-steps-'))
  process.env.AALAI_STATE_DIR = dir
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch })
  base = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  for (const token of granted.splice(0)) {
    revokeToolAccess(token)
  }
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('the step tools', () => {
  test('a step reports start, progress and finish, in that order', async () => {
    const client = await connect(tokenFor('implementer'))
    await client.callTool({ name: 'start_step', arguments: { step_index: 2 } })
    await client.callTool({
      name: 'report_progress',
      arguments: {
        step_index: 2,
        label: 'bun test',
        unit: 'files',
        done: 41,
        total: 68,
      },
    })
    await client.callTool({
      name: 'finish_step',
      arguments: {
        step_index: 2,
        summary: '68 test files pass and the boundary check is clean.',
        files: [
          {
            path: 'src/bytes.ts',
            kind: 'modified',
            additions: 4,
            deletions: 2,
          },
        ],
      },
    })

    const events = stepEvents()
    expect(events.map((event) => event.type)).toEqual([
      'step.started',
      'step.progress',
      'step.finished',
    ])
    for (const event of events) {
      expect(event).toMatchObject({ station: 'implementer', stepIndex: 2 })
    }
    await client.close()
  })

  test('progress carries numbers a bar can be drawn from', async () => {
    const client = await connect(tokenFor('implementer'))
    const result = await client.callTool({
      name: 'report_progress',
      arguments: {
        step_index: 0,
        label: 'bun test',
        unit: 'files',
        done: 17,
        total: 68,
      },
    })

    expect(result.structuredContent).toMatchObject({
      stepIndex: 0,
      done: 17,
      total: 68,
    })
    const progress = stepEvents()[0]
    expect(progress).toMatchObject({ done: 17, total: 68, unit: 'files' })
    await client.close()
  })

  test('a count past the total is refused rather than drawn', async () => {
    const client = await connect(tokenFor('implementer'))
    await client.callTool({
      name: 'report_progress',
      arguments: {
        step_index: 0,
        label: 'bun test',
        unit: 'files',
        done: 90,
        total: 68,
      },
    })

    // Nothing is emitted, because a bar at 132% is worse than no bar.
    expect(stepEvents()).toEqual([])
    await client.close()
  })

  test('finishing names the files, which is what the thread shows', async () => {
    const client = await connect(tokenFor('implementer'))
    const result = await client.callTool({
      name: 'finish_step',
      arguments: {
        step_index: 1,
        summary: 'Moved the regex into shared.',
        files: [
          {
            path: 'src/shared/format.ts',
            kind: 'added',
            additions: 14,
            deletions: 0,
          },
        ],
      },
    })

    expect(result.structuredContent).toMatchObject({
      stepIndex: 1,
      summary: 'Moved the regex into shared.',
    })
    const finished = stepEvents()[0]
    expect(finished).toMatchObject({
      type: 'step.finished',
      files: [
        {
          path: 'src/shared/format.ts',
          kind: 'added',
          additions: 14,
          deletions: 0,
        },
      ],
    })
    await client.close()
  })
})

describe('which station holds which tool', () => {
  test('the implementer reports steps and cannot write the plan', () => {
    expect(STATION_TOOLS.implementer).toContain('report_progress')
    expect(STATION_TOOLS.implementer).not.toContain('write_plan')
  })

  test('the reviewer answers comments and does not report steps', () => {
    expect(STATION_TOOLS.reviewer).toContain('answer_review_comment')
    expect(STATION_TOOLS.reviewer).not.toContain('start_step')
  })

  test('the stations that plan record what they read first', () => {
    expect(STATION_TOOLS.analyst).toContain('report_context')
    expect(STATION_TOOLS.classifier).toContain('report_context')
  })

  test('a station is refused a tool it was not given', async () => {
    const reviewer = await connect(tokenFor('reviewer'))
    const result = await reviewer.callTool({
      name: 'report_progress',
      arguments: { step_index: 0, label: 'x', unit: 'y', done: 1, total: 2 },
    })

    expect(result.isError).toBe(true)
    expect(stepEvents()).toEqual([])
    await reviewer.close()
  })
})
