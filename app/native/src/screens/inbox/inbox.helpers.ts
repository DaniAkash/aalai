/** What a gate is asking, for a row that has one line to say it in. */
export function asking(gate: {
  summary: string | null
  kind: string
  artifactVersion: string | null
}): string {
  if (gate.summary !== null && gate.summary !== '') {
    return gate.summary
  }
  switch (gate.kind) {
    case 'plan':
      return 'approve the plan'
    case 'triage':
      return 'is this worth doing'
    default:
      return gate.kind
  }
}

export interface GateRowish {
  readonly id: string
  readonly kind: string
  readonly runId: string
  readonly openedAt: string
  readonly summary: string | null
  readonly artifactVersion: string | null
}

/**
 * The gates split by what they are actually asking.
 *
 * A triage gate asks whether something is worth doing at all and a plan gate
 * asks whether a change is the right one. In a repository with real traffic the
 * first outnumbers the second, and one undifferentiated list makes the cheap
 * decisions hide the expensive ones.
 */
export function grouped<T extends GateRowish>(
  gates: readonly T[],
): { triage: T[]; plans: T[]; other: T[] } {
  return {
    triage: gates.filter((gate) => gate.kind === 'triage'),
    plans: gates.filter((gate) => gate.kind === 'plan'),
    other: gates.filter(
      (gate) => gate.kind !== 'triage' && gate.kind !== 'plan',
    ),
  }
}
