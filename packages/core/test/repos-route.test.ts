import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MAX_REPOS_PER_ADD } from '@/shared/pickerRows'

/**
 * Adding is the only route here that changes anything, and the two ways it can
 * go wrong are both silent: a repeated name watches a repository twice, and a
 * selection larger than the cap is rejected whole. Neither looks like an error
 * from the interface, so both are pinned down here.
 */

const addSchema = z.object({
  repos: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .min(1)
    .max(MAX_REPOS_PER_ADD),
  requireLabel: z.string().optional(),
  policy: z.enum(['automatic', 'plan_gate', 'triage']),
})

/** The route's own filtering, as a function so it can be checked directly. */
function additions(incoming: string[], alreadyWatched: string[]): string[] {
  const wanted = [...new Set(incoming)]
  const known = new Set(alreadyWatched)
  return wanted.filter((repo) => !known.has(repo))
}

describe('what an add actually writes', () => {
  test('a repeated name is watched once, not twice', () => {
    expect(additions(['acme/app', 'acme/app'], [])).toEqual(['acme/app'])
  })

  test('already watched ones are skipped rather than failing the batch', () => {
    // The only way to send one is a selection that went stale while the panel
    // was open, and losing the other nine choices over it would be worse.
    expect(additions(['acme/app', 'acme/web'], ['acme/app'])).toEqual([
      'acme/web',
    ])
  })

  test('a batch that is entirely already watched adds nothing', () => {
    expect(additions(['acme/app'], ['acme/app'])).toEqual([])
  })

  test('order is kept, so the config reads in the order they were picked', () => {
    expect(additions(['b/b', 'a/a', 'c/c'], [])).toEqual(['b/b', 'a/a', 'c/c'])
  })
})

describe('what the route will accept', () => {
  test('a policy is required, because an absent one used to mean automatic', () => {
    const parsed = addSchema.safeParse({ repos: ['acme/app'] })
    expect(parsed.success).toBe(false)
  })

  test('an empty selection is refused', () => {
    expect(
      addSchema.safeParse({ repos: [], policy: 'plan_gate' }).success,
    ).toBe(false)
  })

  test('a selection at the cap is accepted', () => {
    const repos = Array.from(
      { length: MAX_REPOS_PER_ADD },
      (_, i) => `acme/r${i}`,
    )
    expect(addSchema.safeParse({ repos, policy: 'plan_gate' }).success).toBe(
      true,
    )
  })

  test('one past the cap is refused, which is why the picker stops there', () => {
    const repos = Array.from(
      { length: MAX_REPOS_PER_ADD + 1 },
      (_, i) => `acme/r${i}`,
    )
    expect(addSchema.safeParse({ repos, policy: 'plan_gate' }).success).toBe(
      false,
    )
  })

  test('a name that is not owner/repo is refused', () => {
    expect(
      addSchema.safeParse({ repos: ['not-a-repo'], policy: 'plan_gate' })
        .success,
    ).toBe(false)
  })
})
