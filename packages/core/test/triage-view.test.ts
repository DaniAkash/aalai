import { describe, expect, test } from 'bun:test'
import {
  approvalConsequence,
  approvalLabel,
  classificationLine,
  factsFromReport,
  readsAsQuestion,
  type TriageFacts,
} from '@/shared/triageView'

/**
 * What a person is told before they click.
 *
 * Approving a triage gate can post under the maintainer's name on a public
 * repository, and "approve" does not say which. These are the sentences that
 * do, so they are tested as carefully as the machine is.
 */

function facts(overrides: Partial<TriageFacts> = {}): TriageFacts {
  return {
    classification: 'bug',
    confidence: 'high',
    willComment: false,
    willClose: false,
    ...overrides,
  }
}

describe('saying what approving will do', () => {
  test('an actionable issue starts a run and posts nothing', () => {
    expect(approvalConsequence(facts({ classification: 'bug' }))).toBe(
      'Starts a run. Nothing is posted yet.',
    )
  })

  test('an answer says it will be posted', () => {
    expect(
      approvalConsequence(
        facts({ classification: 'question', willComment: true }),
      ),
    ).toContain('Posts a comment')
  })

  test('a duplicate says it posts and closes', () => {
    expect(
      approvalConsequence(
        facts({
          classification: 'duplicate',
          willComment: true,
          willClose: true,
        }),
      ),
    ).toBe('Posts a comment and closes the issue.')
  })

  test('noise closed without a word says so', () => {
    expect(
      approvalConsequence(facts({ classification: 'noise', willClose: true })),
    ).toBe('Closes the issue. Nothing is posted.')
  })

  test('a security report says nothing will be posted, whatever else is set', () => {
    // Even if something upstream queued a comment, this sentence must not
    // promise it will go out, because it must not.
    expect(
      approvalConsequence(
        facts({
          classification: 'security',
          willComment: true,
          willClose: true,
        }),
      ),
    ).toBe('Nothing will be posted. This is a security report.')
  })
})

describe('a judgement the classifier was unsure about', () => {
  test('low confidence reads as a question', () => {
    expect(readsAsQuestion(facts({ confidence: 'low' }))).toBe(true)
  })

  test('anything else reads as a proposal', () => {
    expect(readsAsQuestion(facts({ confidence: 'medium' }))).toBe(false)
    expect(readsAsQuestion(facts({ confidence: 'high' }))).toBe(false)
  })

  test('a confident duplicate is stated', () => {
    expect(
      classificationLine(
        facts({ classification: 'duplicate', duplicateOf: 12 }),
      ),
    ).toBe('duplicate of #12')
  })

  test('an unsure one is asked', () => {
    // Being wrong here is expensive and rude, so it is put as a question.
    expect(
      classificationLine(
        facts({
          classification: 'duplicate',
          confidence: 'low',
          duplicateOf: 12,
        }),
      ),
    ).toBe('possibly duplicate of #12?')
  })

  test('and its button asks rather than approves', () => {
    expect(
      approvalLabel(
        facts({
          classification: 'duplicate',
          confidence: 'low',
          // The proposal it is hedging about: closing. A duplicate still
          // waiting on the reporter closes nothing and says so instead.
          willClose: true,
        }),
      ),
    ).toBe('Close as duplicate')
  })

  test('an actionable one says what it starts', () => {
    expect(approvalLabel(facts({ classification: 'bug' }))).toBe(
      'Approve and start',
    )
  })
})

describe('the consequence agrees with what will actually happen', () => {
  const asking = [
    '---',
    'classification: noise',
    'confidence: high',
    '---',
    '',
    '**Classification:** noise',
    '',
    '## Missing',
    '',
    '- the input that was passed',
    '- the output that was expected',
    '',
    '## Drafted reply',
    '',
    'What did you pass in?',
  ].join('\n')

  const settled = asking.replace(
    '- the input that was passed\n- the output that was expected',
    '_Nothing._',
  )

  test('a report that asks for detail does not promise a close', () => {
    // Delivery suppresses the close whenever something is missing, because the
    // run is about to wait weeks on the reporter. The sentence above the button
    // has to say the same thing.
    const facts = factsFromReport(asking)
    expect(facts?.willClose).toBe(false)
    expect(approvalConsequence(facts as TriageFacts)).not.toContain('closes')
  })

  test('the same report with nothing missing does', () => {
    const facts = factsFromReport(settled)
    expect(facts?.willClose).toBe(true)
  })
})

describe('the button and the sentence describe the same decision', () => {
  test('a duplicate that will not close does not offer to close it', () => {
    // Found by rendering a real report: the line said "Posts a comment on the
    // issue" while the button beside it said "Close as duplicate".
    const facts: TriageFacts = {
      classification: 'duplicate',
      confidence: 'low',
      willComment: true,
      willClose: false,
    }
    expect(approvalLabel(facts)).toBe('Approve')
    expect(approvalConsequence(facts)).toBe('Posts a comment on the issue.')
  })

  test('one that will close still offers to', () => {
    const facts: TriageFacts = {
      classification: 'duplicate',
      confidence: 'low',
      willComment: true,
      willClose: true,
    }
    expect(approvalLabel(facts)).toBe('Close as duplicate')
  })
})
