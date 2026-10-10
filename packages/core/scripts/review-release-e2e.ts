import { listReviewThreads, threadHolding } from '@/lib/ghReview'
import { answerGate } from '@/modules/gates/gates'
import { deliverOutbox } from '@/modules/outbound/deliver'
import { readReviewRecords, unsentAnswers } from '@/modules/work/reviews'
import { queueOutbound } from '@/modules/work/store'
import { openReviewRelease } from '@/run/reviewRelease'
import { openState } from '@/watch/state'

/**
 * Releasing a review's answers to GitHub, end to end.
 *
 * Opens the gate the way the run does, answers it the way a person does, and
 * delivers it the way delivery does. The replies land in the threads a
 * reviewer opened and the threads close behind them, which is checked by
 * reading GitHub back rather than by trusting what was returned.
 *
 * Arguments: `owner/name#pr` and the issue number its thread belongs to.
 */

const [target = 'DaniAkash/aalai-demo#69', issueArg = '68'] = Bun.argv.slice(2)
const [repo = '', prText = '0'] = target.split('#')
const prNumber = Number(prText)
const subject = { repo, kind: 'issue' as const, number: Number(issueArg) }
const runId = `${repo}#${subject.number}@${Date.now()}`
const run = { subject, runId }
const say = (line: string) => process.stdout.write(`${line}\n`)

const db = openState()
try {
  const pending = await unsentAnswers(subject)
  say(`answers waiting to be sent: ${pending.length}`)
  for (const answer of pending) {
    say(`  ${answer.threadId}: ${answer.answer.slice(0, 60)}`)
  }
  if (pending.length === 0) {
    say('  nothing to release; answer a review first')
    process.exit(1)
  }

  const release = await openReviewRelease(db, run, 0)
  if (release === undefined) {
    process.exit(1)
  }
  say(`gate opened: ${release.gateId}`)
  say(`  carrying ${release.answers.length} answer(s), which is the batch`)

  // The intents the station would have queued when it answered.
  for (const answer of release.answers) {
    await queueOutbound(
      run,
      {
        kind: 'reply_to_review',
        body: answer.answer,
        threadId: answer.threadId,
        prNumber,
        station: 'reviewer',
        queuedAt: new Date().toISOString(),
        gateId: release.gateId,
      },
      `reply-${answer.threadId}`,
    )
  }

  say('a person releases it')
  answerGate(db, {
    gateId: release.gateId,
    decision: 'approved',
    answeredBy: 'you',
    answeredOn: 'app',
  })

  const report = await deliverOutbox({
    db,
    run,
    repo,
    issueNumber: subject.number,
    released: release.gateId,
  })
  say(
    `  delivered ${report.delivered.length}, refused ${report.refused.length}, failed ${report.failed.length}`,
  )
  for (const one of report.failed) {
    say(`  failed: ${one.error}`)
  }

  say('reading GitHub back')
  const threads = await listReviewThreads(repo, prNumber)
  for (const answer of release.answers) {
    const thread = threadHolding(threads, answer.threadId)
    say(
      `  ${answer.threadId}: ${thread === undefined ? 'no thread (a summary)' : `resolved=${thread.isResolved}`}`,
    )
  }

  say('what the thread now says')
  const records = await readReviewRecords(subject)
  for (const record of records) {
    if (record.kind !== 'answer') {
      continue
    }
    const state =
      record.resolvedAt != null
        ? 'resolved'
        : record.postedAt != null
          ? 'sent'
          : 'recorded'
    say(
      `  ${record.threadId} -> ${state}${record.postedUrl ? ` ${record.postedUrl}` : ''}`,
    )
  }
} finally {
  db.close()
}
