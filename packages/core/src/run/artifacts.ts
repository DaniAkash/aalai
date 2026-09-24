import type { GhIssue } from '@/lib/gh'
import { writeArtifact } from '@/modules/work/artifacts'
import type { RunRef, Subject } from '@/modules/work/paths'
import { writeJson } from '@/modules/work/store'
import type { PipelineResult } from '@/run/pipeline'
import type { Analysis, Review } from '@/run/stations/schemas'

/**
 * Turning what a station decided into the files the brain later reads.
 *
 * The markdown is the artifact a person or an agent reads; the JSON beside it
 * under the run is the machine's copy. Which run produced an artifact is the
 * one fact not derivable from its path, so it travels in the frontmatter with
 * the content rather than in a row that could drift from it.
 */

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n`
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n')
}

function planMarkdown(
  issue: GhIssue,
  analysis: Analysis,
  runId: string,
): string {
  return `${frontmatter({
    kind: 'plan',
    run: runId,
    issue: String(issue.number),
    created: new Date().toISOString(),
  })}
# Plan for #${issue.number}: ${issue.title}

## Problem

${analysis.problem_statement}

## Approach

${analysis.approach}

## Steps

${numbered(analysis.plan)}

## Affected surface

${bullets(analysis.affected_surface)}

## Risks

${bullets(analysis.risks)}

## Test strategy

${analysis.test_strategy}
`
}

function criteriaMarkdown(
  issue: GhIssue,
  analysis: Analysis,
  runId: string,
): string {
  return `${frontmatter({
    kind: 'criteria',
    run: runId,
    issue: String(issue.number),
    created: new Date().toISOString(),
  })}
# Acceptance criteria for #${issue.number}

Written before any code exists, and handed to the reviewer verbatim.

${analysis.acceptance_criteria.map((c) => `- [ ] ${c}`).join('\n')}
`
}

function reviewMarkdown(issue: GhIssue, review: Review, runId: string): string {
  const results = review.criteria_results
    .map(
      (result) =>
        `### ${result.pass ? 'Met' : 'Not met'}: ${result.criterion}\n\n${result.evidence}`,
    )
    .join('\n\n')
  const findings =
    review.blocking_findings.length === 0
      ? '_None._'
      : bullets(review.blocking_findings)

  return `${frontmatter({
    kind: 'review',
    run: runId,
    issue: String(issue.number),
    verdict: review.verdict,
    created: new Date().toISOString(),
  })}
# Review of #${issue.number}

**Verdict:** ${review.verdict}

${review.summary}

## Criteria

${results}

## Blocking findings

${findings}
`
}

/** The plan and the criteria, versioned, plus the analyst's structured output. */
export async function recordAnalysis(
  subject: Subject,
  run: RunRef,
  issue: GhIssue,
  analysis: Analysis,
): Promise<void> {
  await writeArtifact(subject, 'plan', planMarkdown(issue, analysis, run.runId))
  await writeArtifact(
    subject,
    'criteria',
    criteriaMarkdown(issue, analysis, run.runId),
  )
  await writeJson(run, 'analysis', analysis)
}

export async function recordReview(
  subject: Subject,
  run: RunRef,
  issue: GhIssue,
  review: Review,
): Promise<void> {
  await writeArtifact(
    subject,
    'review',
    reviewMarkdown(issue, review, run.runId),
  )
  await writeJson(run, 'review', review)
}

export interface RunSnapshot {
  readonly runId: string
  readonly repo: string
  readonly issue: number
  readonly status: string
  readonly branch?: string
  readonly prUrl?: string
  readonly error?: string
  readonly finishedAt: string
}

export function snapshotOf(
  runId: string,
  repo: string,
  issue: number,
  result: PipelineResult,
): RunSnapshot {
  return {
    runId,
    repo,
    issue,
    status: result.status,
    ...(result.branch === undefined ? {} : { branch: result.branch }),
    ...(result.prUrl === undefined ? {} : { prUrl: result.prUrl }),
    ...(result.error === undefined ? {} : { error: result.error }),
    finishedAt: new Date().toISOString(),
  }
}

export async function recordRun(
  run: RunRef,
  snapshot: RunSnapshot,
): Promise<void> {
  await writeJson(run, 'run', snapshot)
}
