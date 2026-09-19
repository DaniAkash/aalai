import { beforeEach, describe, expect, test } from 'bun:test'
import { activeRuns, emit, latestRunId, registerRunRoot, replay, resetBus, subscribe } from '@/events/bus'
import type { RunEvent } from '@/events/events.types'

const RUN = 'acme/widgets#7@1'

function event(over: Partial<RunEvent> & Pick<RunEvent, 'type'>): RunEvent {
  return { runId: RUN, at: 1, ...over } as RunEvent
}

beforeEach(() => resetBus())

describe('a late subscriber still sees the whole run', () => {
  test('replay returns everything emitted before it arrived', () => {
    emit(event({ type: 'run.started', repo: 'acme/widgets', issue: 7, title: 'x' } as never))
    emit(event({ type: 'stage.entered', stage: 'analyst' } as never))
    expect(replay(RUN)).toHaveLength(2)
  })

  test('a subscriber receives events emitted after it arrives', () => {
    const seen: string[] = []
    subscribe((e) => seen.push(e.type))
    emit(event({ type: 'stage.entered', stage: 'analyst' } as never))
    emit(event({ type: 'commit.made', sha: 'abc', attempt: 0 } as never))
    expect(seen).toEqual(['stage.entered', 'commit.made'])
  })

  test('one broken subscriber does not take the run down', () => {
    const seen: string[] = []
    subscribe(() => {
      throw new Error('subscriber exploded')
    })
    subscribe((e) => seen.push(e.type))
    expect(() => emit(event({ type: 'run.stopped', reason: 'x' } as never))).not.toThrow()
    expect(seen).toEqual(['run.stopped'])
  })
})

describe('events are redacted before anyone can see them', () => {
  const WORKTREE = '/Users/someone/workbench/worktrees/Acme/widgets/aalai-issue-7'

  test('an agent citing an absolute path publishes a repository path', () => {
    registerRunRoot(RUN, WORKTREE)
    emit(
      event({
        type: 'agent.text',
        station: 'implementer',
        text: `Fixed it in ${WORKTREE}/src/clamp.ts:6.`,
      } as never),
    )
    const [first] = replay(RUN)
    expect(JSON.stringify(first)).not.toContain('/Users/')
    expect(JSON.stringify(first)).toContain('src/clamp.ts:6')
  })

  test('redaction reaches nested fields, not just the top level', () => {
    registerRunRoot(RUN, WORKTREE)
    emit(
      event({
        type: 'review.verdict',
        verdict: 'approve',
        results: [{ criterion: 'c', pass: true, evidence: `see ${WORKTREE}/src/a.ts` }],
      } as never),
    )
    expect(JSON.stringify(replay(RUN))).not.toContain('/Users/')
  })
})

describe('the buffer is bounded', () => {
  test('a long run keeps its most recent events rather than growing forever', () => {
    for (let i = 0; i < 600; i += 1) {
      emit(event({ type: 'agent.tool', station: 'implementer', tool: `tool-${i}` } as never))
    }
    const events = replay(RUN)
    expect(events.length).toBeLessThanOrEqual(400)
    expect(JSON.stringify(events.at(-1))).toContain('tool-599')
  })

  test('old runs are evicted so memory does not grow across a long session', () => {
    for (let i = 0; i < 25; i += 1) {
      emit({ type: 'run.started', runId: `r${i}`, repo: 'a/b', issue: i, title: 't', at: 1 })
    }
    expect(activeRuns().length).toBeLessThanOrEqual(20)
    expect(latestRunId()).toBe('r24')
  })
})
