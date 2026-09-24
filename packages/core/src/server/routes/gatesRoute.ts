import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { GATE_DECISIONS, GATE_STATUSES } from '@/modules/db/schema/schema'
import {
  ANSWER_SOURCES,
  answerGate,
  listGates,
  readGate,
} from '@/modules/gates'
import { readArtifact } from '@/modules/work/artifacts'
import { openState } from '@/watch/state'

const answerSchema = z.object({
  decision: z.enum(GATE_DECISIONS),
  reason: z.string().max(4000).optional(),
  answeredBy: z.string().min(1).max(200),
  answeredOn: z.enum(ANSWER_SOURCES).default('app'),
})

const listSchema = z.object({
  status: z.enum(GATE_STATUSES).default('open'),
  runId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/**
 * The gate surface.
 *
 * Every handler is async and every body goes through a validator, so the
 * client's `InferRequestType` describes the payload rather than leaving the UI
 * to redeclare it and drift.
 */
export const gatesRoute = new Hono()
  .get('/gates', zValidator('query', listSchema), async (c) => {
    const { status, runId, limit } = c.req.valid('query')
    const db = openState()
    const gates = listGates(db, {
      status,
      ...(runId === undefined ? {} : { runId }),
      ...(limit === undefined ? {} : { limit }),
    })
    db.close()
    return c.json({ gates })
  })
  .get('/gates/:id', async (c) => {
    const db = openState()
    const gate = readGate(db, c.req.param('id'))
    db.close()
    if (gate === undefined) {
      return c.json({ error: 'no such gate' }, 404)
    }
    const artifact =
      gate.artifactPath === null
        ? undefined
        : await readArtifact(gate.artifactPath)
    return c.json({ gate, artifact: artifact ?? null })
  })
  .post('/gates/:id/answer', zValidator('json', answerSchema), async (c) => {
    const body = c.req.valid('json')
    const db = openState()
    const result = answerGate(db, {
      gateId: c.req.param('id'),
      decision: body.decision,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      answeredBy: body.answeredBy,
      answeredOn: body.answeredOn,
    })
    db.close()
    if (result.ok) {
      return c.json(result)
    }
    // A refusal is an ordinary outcome, not a server fault: three surfaces can
    // answer the same gate and two of them racing is expected. 409 so a client
    // can tell it apart from a bad request without parsing prose.
    return c.json(result, result.refusal.kind === 'not_found' ? 404 : 409)
  })
