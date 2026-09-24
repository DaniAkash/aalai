import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  activeToolGrants,
  grantToolAccess,
  revokeToolAccess,
  type ToolContext,
} from '@/modules/tools/context'
import { STATION_TOOLS } from '@/modules/tools/registry'
import { findArtifacts, readArtifact } from '@/modules/work/artifacts'
import type { Subject } from '@/modules/work/paths'
import { readOutbound } from '@/modules/work/store'
import { app } from '@/server/app'

let dir: string
let server: ReturnType<typeof Bun.serve>
let base: string

const SUBJECT: Subject = { repo: 'acme/widgets', kind: 'issue', number: 27 }
const RUN_ID = 'acme/widgets#27@1790000000000'

function contextFor(
  station: ToolContext['station'],
): Omit<ToolContext, 'written' | 'queued' | 'recorded'> {
  return {
    runId: RUN_ID,
    title: 'pluralise always returns the plural form',
    subject: SUBJECT,
    run: { subject: SUBJECT, runId: RUN_ID },
    station,
  }
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp/${token}`)),
  )
  return client
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalai-tools-'))
  process.env.AALAI_STATE_DIR = dir
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch })
  base = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('the run token', () => {
  test('an unknown token is refused', async () => {
    const response = await fetch(`${base}/api/mcp/not-a-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })

  test('a revoked token stops working, so it cannot outlive the turn', async () => {
    const token = grantToolAccess(contextFor('analyst')).token
    revokeToolAccess(token)
    const response = await fetch(`${base}/api/mcp/${token}`, { method: 'POST' })
    expect(response.status).toBe(404)
    expect(activeToolGrants()).toBe(0)
  })
})

describe('which tools a station is given', () => {
  test('the analyst can write a plan and the implementer cannot', async () => {
    const analyst = await connect(grantToolAccess(contextFor('analyst')).token)
    const implementer = await connect(
      grantToolAccess(contextFor('implementer')).token,
    )

    const analystTools = (await analyst.listTools()).tools.map((t) => t.name)
    const implementerTools = (await implementer.listTools()).tools.map(
      (t) => t.name,
    )

    expect(analystTools).toContain('write_plan')
    expect(implementerTools).not.toContain('write_plan')
    await analyst.close()
    await implementer.close()
  })

  test('the reviewer cannot rewrite the criteria it grades against', async () => {
    const reviewer = await connect(
      grantToolAccess(contextFor('reviewer')).token,
    )
    const tools = (await reviewer.listTools()).tools.map((t) => t.name)
    expect(tools).toContain('write_review')
    expect(tools).not.toContain('write_plan')
    await reviewer.close()
  })

  test('calling a tool it was not given is refused, not quietly ignored', async () => {
    const implementer = await connect(
      grantToolAccess(contextFor('implementer')).token,
    )
    const result = await implementer.callTool({
      name: 'write_plan',
      arguments: {},
    })

    // The protocol answers a missing tool with an error result rather than a
    // transport failure, so the agent is told plainly instead of the call
    // succeeding silently and nothing being written.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')

    const plans = await findArtifacts({ subject: SUBJECT, kind: 'plan' })
    expect(plans).toEqual([])
    await implementer.close()
  })

  test('the registry and what is served agree', async () => {
    for (const station of ['analyst', 'implementer', 'reviewer'] as const) {
      const client = await connect(grantToolAccess(contextFor(station)).token)
      const served = (await client.listTools()).tools.map((t) => t.name).sort()
      const declared = [
        ...STATION_TOOLS[station],
        'comment_on_issue',
        'reply_to_review',
      ].sort()
      expect(served).toEqual(declared)
      await client.close()
    }
  })
})

describe('write_plan', () => {
  test('writes a versioned plan and criteria the store can read back', async () => {
    const client = await connect(grantToolAccess(contextFor('analyst')).token)
    const result = await client.callTool({
      name: 'write_plan',
      arguments: {
        problem_statement: 'pluralise ignores the count',
        approach: 'select the singular only for exactly one',
        plan: ['fix the helper', 'cover it with tests'],
        affected_surface: ['src/pluralise.ts'],
        risks: [],
        test_strategy: 'unit tests for 1, 0, -1 and 3',
        acceptance_criteria: [
          'one returns the singular',
          'three returns plural',
        ],
      },
    })

    expect(JSON.stringify(result.content)).toContain('version 1')

    const plan = await findArtifacts({ subject: SUBJECT, kind: 'plan' })
    const criteria = await findArtifacts({ subject: SUBJECT, kind: 'criteria' })
    expect(plan).toHaveLength(1)
    expect(criteria).toHaveLength(1)

    const body = await readArtifact(plan[0]?.id ?? '')
    expect(body).toContain('pluralise ignores the count')
    expect(body).toContain(RUN_ID)
    await client.close()
  })

  test('a second call versions rather than overwrites', async () => {
    const client = await connect(grantToolAccess(contextFor('analyst')).token)
    const args = {
      problem_statement: 'first',
      approach: 'a',
      plan: ['one'],
      affected_surface: [],
      risks: [],
      test_strategy: 't',
      acceptance_criteria: ['c'],
    }
    await client.callTool({ name: 'write_plan', arguments: args })
    await client.callTool({
      name: 'write_plan',
      arguments: { ...args, problem_statement: 'second' },
    })

    const plans = await findArtifacts({ subject: SUBJECT, kind: 'plan' })
    expect(plans.map((p) => p.version)).toEqual([1, 2])
    expect(await readArtifact(plans[0]?.id ?? '')).toContain('first')
    await client.close()
  })

  test('the agent cannot choose the version', async () => {
    const client = await connect(grantToolAccess(contextFor('analyst')).token)
    const schema = (await client.listTools()).tools.find(
      (t) => t.name === 'write_plan',
    )?.inputSchema
    expect(JSON.stringify(schema)).not.toContain('version')
    await client.close()
  })
})

describe('write_review', () => {
  test('records the verdict and its evidence', async () => {
    const client = await connect(grantToolAccess(contextFor('reviewer')).token)
    await client.callTool({
      name: 'write_review',
      arguments: {
        verdict: 'approve',
        criteria_results: [
          {
            criterion: 'one returns the singular',
            pass: true,
            evidence: 'asserted in the test',
          },
        ],
        blocking_findings: [],
        summary: 'looks right',
      },
    })
    const reviews = await findArtifacts({ subject: SUBJECT, kind: 'review' })
    const body = await readArtifact(reviews[0]?.id ?? '')
    expect(body).toContain('approve')
    expect(body).toContain('asserted in the test')
    await client.close()
  })
})

describe('outbound intents', () => {
  test('a comment is queued, not sent', async () => {
    const client = await connect(grantToolAccess(contextFor('analyst')).token)
    const result = await client.callTool({
      name: 'comment_on_issue',
      arguments: { body: 'I need more detail about the expected output.' },
    })

    expect(JSON.stringify(result.content)).toContain('queued')
    const queued = await readOutbound({ subject: SUBJECT, runId: RUN_ID })
    expect(queued).toHaveLength(1)
    expect(queued[0]?.kind).toBe('comment_on_issue')
    expect(queued[0]?.body).toContain('more detail')
    await client.close()
  })
})

describe('recall', () => {
  test('find_artifacts returns ids, never bodies', async () => {
    const analyst = await connect(grantToolAccess(contextFor('analyst')).token)
    await analyst.callTool({
      name: 'write_plan',
      arguments: {
        problem_statement: 'a very distinctive sentence',
        approach: 'a',
        plan: ['one'],
        affected_surface: [],
        risks: [],
        test_strategy: 't',
        acceptance_criteria: ['c'],
      },
    })

    const found = await analyst.callTool({
      name: 'find_artifacts',
      arguments: {},
    })
    const rendered = JSON.stringify(found.content)
    expect(rendered).toContain('plan.v1.md')
    expect(rendered).not.toContain('a very distinctive sentence')
    await analyst.close()
  })
})
