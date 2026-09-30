import { describe, expect, test } from 'bun:test'
import { decisionsFor } from '@/modules/gates'
import {
  type TrustFacts,
  trustConsequence,
  trustLabel,
  trustReason,
} from '@/shared/triageView'

/**
 * How the most consequential gate in the product reads.
 *
 * Everything else a gate has asked could be undone: a comment deleted, a branch
 * thrown away, a pull request closed. This one runs somebody else's code on the
 * machine of the person reading it, and nothing undoes that. The wording is
 * tested because a word like approve would hide exactly that.
 */

const facts: TrustFacts = {
  because:
    'a commit by an account this repository does not know (Alex Contributor)',
}

describe('what approving it does', () => {
  test('says it runs code, in those words', () => {
    const said = trustConsequence()
    expect(said).toContain('Runs')
    expect(said).toContain('on your machine')
  })

  test('and the reason names whose code it is', () => {
    // On the reason rather than the consequence: the reason is what Q2
    // established, and the consequence is the same sentence however it came to
    // be asked.
    expect(trustReason(facts)).toContain('Alex Contributor')
  })

  test('and the same sentence however it came to be asked', () => {
    // The consequence of running somebody else's code does not change with who
    // they are or why it was noticed, so it is not assembled from either.
    expect(trustConsequence()).toBe(trustConsequence())
  })

  test('the button does not say approve', () => {
    // Approve is what it would say if this were a plan, and the difference
    // between approving a plan and running a stranger's code is the whole
    // point of the gate.
    expect(trustLabel().toLowerCase()).not.toContain('approve')
  })

  test('and it says why it is being asked at all', () => {
    expect(trustReason(facts)).toContain('does not know')
  })
})

describe('what may be said to it', () => {
  test('only run it or do not', () => {
    expect(decisionsFor('trust')).toEqual(['approved', 'rejected'])
  })

  test('there is nothing to send back for changes', () => {
    // A trust gate is not a question about the code. The review already said
    // everything it could without running it.
    expect(decisionsFor('trust')).not.toContain('changes')
  })
})
