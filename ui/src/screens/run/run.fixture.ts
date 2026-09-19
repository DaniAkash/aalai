import type { RunEvent } from '@/screens/run/run.types'

/**
 * A real run, replayed.
 *
 * Taken from the clamp run against the scratch repository, including the
 * reviewer's own edge-case probes. It exists so the screen can be built and
 * judged before the event stream is wired, and so the layout is exercised
 * against real criteria lengths rather than convenient short ones.
 */
export const CLAMP_RUN: readonly RunEvent[] = [
  { type: 'run.started', repo: 'DaniAkash/aalai-demo', issue: 11, title: 'clamp never applies the upper bound' },
  { type: 'stage.entered', stage: 'workspace' },
  {
    type: 'workspace.ready',
    branch: 'aalai/issue-11-clamp-never-applies-the-upper-bound',
    base: 'main',
    conventions: ['AGENTS.md'],
  },

  { type: 'stage.entered', stage: 'analyst' },
  { type: 'agent.tool', station: 'analyst', tool: "sed -n '1,180p' AGENTS.md" },
  { type: 'agent.tool', station: 'analyst', tool: 'rg --files -g "!node_modules"' },
  { type: 'agent.tool', station: 'analyst', tool: "sed -n '1,120p' src/clamp.ts" },
  {
    type: 'agent.text',
    station: 'analyst',
    text: 'The function checks the lower bound and returns min when the value is below it, but never compares against max, so the upper bound has no effect.',
  },
  {
    type: 'analysis.ready',
    steps: 5,
    criteria: [
      'clamp(42, 0, 10) returns exactly 10',
      'clamp(-5, 0, 10) continues to return exactly 0',
      'a value already inside the range is returned unchanged',
      'the exported signature and parameter order are unchanged',
    ],
  },

  { type: 'stage.entered', stage: 'implementer' },
  { type: 'agent.tool', station: 'implementer', tool: 'sed -n "1,120p" src/clamp.ts' },
  { type: 'agent.tool', station: 'implementer', tool: 'Editing files' },
  { type: 'agent.tool', station: 'implementer', tool: 'bun test test/clamp.test.ts' },
  {
    type: 'agent.text',
    station: 'implementer',
    text: 'Added the upper-bound branch without changing the signature or the existing return path. The focused test passes, two of two.',
  },
  { type: 'commit.made', sha: '96fc21c0a1', attempt: 0 },

  { type: 'stage.entered', stage: 'reviewer' },
  { type: 'agent.tool', station: 'reviewer', tool: 'git diff main...aalai/issue-11' },
  { type: 'agent.tool', station: 'reviewer', tool: 'bun test test/clamp.test.ts' },
  { type: 'agent.tool', station: 'reviewer', tool: 'bun -e "…boundary probe…"' },
  {
    type: 'agent.text',
    station: 'reviewer',
    text: 'The diff is narrowly scoped and preserves the export signature. I verified both stated examples and the in-range case against executable output rather than the summary.',
  },
  {
    type: 'review.verdict',
    verdict: 'approve',
    results: [
      { criterion: 'clamp(42, 0, 10) returns exactly 10', pass: true, evidence: 'Direct invocation returned 10, and the targeted test passed.' },
      { criterion: 'clamp(-5, 0, 10) continues to return exactly 0', pass: true, evidence: 'Direct invocation returned 0.' },
      { criterion: 'a value already inside the range is returned unchanged', pass: true, evidence: 'Probe clamp(7, 0, 10) returned 7.' },
      { criterion: 'the exported signature and parameter order are unchanged', pass: true, evidence: 'The diff leaves the declaration untouched and typecheck passed.' },
    ],
  },

  { type: 'stage.entered', stage: 'deliver' },
  {
    type: 'run.delivered',
    prUrl: 'https://github.com/DaniAkash/aalai-demo/pull/12',
    branch: 'aalai/issue-11-clamp-never-applies-the-upper-bound',
  },
]
