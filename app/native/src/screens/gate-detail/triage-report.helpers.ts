import type { TriageFacts } from 'aalai/shared'

/**
 * Reads the facts a decision needs back out of the report.
 *
 * The report is markdown with frontmatter, because an artifact is what a person
 * reads and the database stores its path rather than its content. The three
 * values the buttons depend on are parsed back out here rather than being
 * carried separately, so there is one copy of them and it is the one on disk.
 */
export function factsFromReport(report: string | null): TriageFacts {
  const classification = field(report, 'classification') ?? 'bug'
  // The report writes it as "**Duplicates:** #12"; the schema calls it
  // `duplicate_of`. Both spellings are looked for rather than one being made
  // to match the other, because the report is what a person reads.
  const duplicate = Number(
    field(report, 'duplicate_of') ?? field(report, 'duplicates') ?? '',
  )
  return {
    classification,
    confidence: field(report, 'confidence') ?? 'medium',
    duplicateOf:
      Number.isFinite(duplicate) && duplicate > 0 ? duplicate : undefined,
    // A reply was drafted, so approving says it. Read from the report for the
    // same reason as the rest: the artifact is the record.
    willComment:
      classification !== 'security' &&
      (report ?? '').includes('## Drafted reply'),
    willClose:
      classification === 'duplicate' ||
      classification === 'noise' ||
      classification === 'question',
  }
}

/** A frontmatter value, or a bold field in the body, whichever the report used. */
function field(report: string | null, name: string): string | undefined {
  if (report === null) {
    return undefined
  }
  const front = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(report)
  if (front?.[1] !== undefined) {
    return front[1].trim()
  }
  const label = name.replace(/_/g, ' ')
  const bold = new RegExp(`\\*\\*${label}:\\*\\*\\s*#?(.+)`, 'i').exec(report)
  return bold?.[1]?.trim()
}
