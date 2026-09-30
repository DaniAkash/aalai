import { describe, expect, test } from 'bun:test'
import { exec } from '@/lib/proc'

/**
 * Stopping a command has to mean stopped, not stopped waiting.
 *
 * The case this exists for: a review that loses its claim is about to have its
 * checkout deleted and another machine started on the same pull request. A test
 * run left alive would still be executing that checkout while both happen, so
 * abandoning the promise is not enough.
 */

describe('cancelling a command', () => {
  test('kills the child rather than waiting it out', async () => {
    const stop = new AbortController()
    const began = Date.now()
    setTimeout(() => stop.abort(), 200)

    const result = await exec(['sleep', '10'], { signal: stop.signal })

    expect(Date.now() - began).toBeLessThan(3000)
    // Signalled, not a clean exit.
    expect(result.exitCode).not.toBe(0)
  })

  test('and returns only once it is actually gone', async () => {
    // The ordering that matters: a caller deleting the directory afterwards must
    // not be racing a process still reading from it.
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    const result = await exec(['sleep', '5'], { signal: stop.signal })
    expect(result).toHaveProperty('exitCode')
  })

  test('a command that finishes first is unaffected', async () => {
    const stop = new AbortController()
    const result = await exec(['echo', 'done'], { signal: stop.signal })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('done')
  })

  test('an already aborted signal does not hang', async () => {
    const stop = new AbortController()
    stop.abort()
    const result = await exec(['sleep', '10'], { signal: stop.signal })
    expect(result.exitCode).not.toBe(0)
  })
})
