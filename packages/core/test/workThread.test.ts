import { describe, expect, test } from 'bun:test'
import { gateSentence, placementOf, type Turn } from '@/shared/threadView'

const base = { id: 't', at: '2026-01-01T00:00:00.000Z', author: 'x' } as const

describe('placementOf', () => {
  test('a person sits on the right and a station on the left', () => {
    expect(
      placementOf({ ...base, kind: 'said', voice: 'maintainer', body: 'b' }),
    ).toBe('right')
    expect(
      placementOf({ ...base, kind: 'said', voice: 'station', body: 'b' }),
    ).toBe('left')
  })

  test('a reporter is not a maintainer', () => {
    // They do not work here, so their words must not read as an instruction
    // the way a maintainer's do.
    expect(
      placementOf({ ...base, kind: 'said', voice: 'reporter', body: 'b' }),
    ).toBe('left')
  })

  test('anything the machine did is centred', () => {
    const gate: Turn = {
      ...base,
      kind: 'gate',
      voice: 'system',
      gateId: 'g',
      gateKind: 'plan',
      status: 'answered',
      decision: 'approved',
      summary: null,
      artifact: null,
      artifactVersion: '2',
    }
    expect(placementOf(gate)).toBe('centre')
  })
})

describe('gateSentence', () => {
  const gate = (
    decision: string | null,
    artifactVersion: string | null = '2',
  ): Extract<Turn, { kind: 'gate' }> => ({
    ...base,
    kind: 'gate',
    voice: 'system',
    gateId: 'g',
    gateKind: 'plan',
    status: decision === null ? 'open' : 'answered',
    decision,
    summary: null,
    artifact: null,
    artifactVersion,
  })

  test('names the version, because approval pins to one', () => {
    expect(gateSentence(gate('approved'))).toBe('Approved the plan v2')
  })

  test('every decision the database allows has a sentence', () => {
    for (const decision of ['approved', 'rejected', 'changes', 'reclassify']) {
      expect(gateSentence(gate(decision))).not.toContain('Waiting on you')
    }
  })

  test('an unanswered gate reads as a question', () => {
    expect(gateSentence(gate(null))).toBe('Waiting on you: the plan v2')
  })

  test('a gate with no artifact names only its kind', () => {
    expect(gateSentence(gate('approved', null))).toBe('Approved the plan')
  })
})
