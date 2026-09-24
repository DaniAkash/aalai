/** What a gate is asking, for a row that has one line to say it in. */
export function asking(gate: {
  summary: string | null
  kind: string
  artifactVersion: string | null
}): string {
  if (gate.summary !== null && gate.summary !== '') {
    return gate.summary
  }
  return gate.kind === 'plan'
    ? `approve the plan (v${gate.artifactVersion ?? '?'})`
    : gate.kind
}
