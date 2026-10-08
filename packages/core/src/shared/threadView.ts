/**
 * One piece of work, as a conversation.
 *
 * Everything that happened to a subject arrives from three places: what people
 * and stations said, what the stations recorded, and what a person was asked to
 * allow. They are merged into one ordered list here rather than in the screen,
 * so the thread is a thing the server can be asked for and tested, not a shape
 * three hooks happen to produce when rendered together.
 */

export const TURN_KINDS = ['said', 'recorded', 'gate'] as const
export type TurnKind = (typeof TURN_KINDS)[number]

/** Who is speaking, which is the only thing that decides where a turn sits. */
export type Voice = 'maintainer' | 'station' | 'reporter' | 'system'

export interface TurnBase {
  /** Stable within one thread, so a list has keys that survive a refetch. */
  readonly id: string
  readonly at: string
  readonly voice: Voice
  /** The station or person, shown in the byline. */
  readonly author: string
}

export type Turn = TurnBase &
  (
    | { readonly kind: 'said'; readonly body: string }
    | {
        /** A station wrote something down: a plan, criteria, a review. */
        readonly kind: 'recorded'
        readonly artifact: string
        readonly artifactKind: string
        readonly version: number
      }
    | {
        readonly kind: 'gate'
        readonly gateId: string
        readonly gateKind: string
        readonly status: string
        readonly decision: string | null
        readonly summary: string | null
        readonly artifact: string | null
        readonly artifactVersion: string | null
      }
  )

export interface ThreadView {
  readonly turns: readonly Turn[]
  /** The latest plan, which is what an approval pins to. */
  readonly plan: {
    readonly artifact: string
    readonly version: number
    readonly body: string
  } | null
  /** The gate waiting on a person, when one is. */
  readonly awaiting: {
    readonly gateId: string
    readonly kind: string
    readonly summary: string | null
    readonly artifact: string | null
    readonly artifactVersion: string | null
  } | null
}

/**
 * Where a turn belongs on screen.
 *
 * Position is the whole identity scheme: a person's words sit right, a
 * station's work sits left, and anything the machine did sits centred. Reading
 * the thread should not require reading the bylines.
 */
export function placementOf(turn: Turn): 'right' | 'left' | 'centre' {
  if (turn.voice === 'maintainer') {
    return 'right'
  }
  if (turn.voice === 'system') {
    return 'centre'
  }
  return 'left'
}

/** What a decided gate reads as, in the centred pill. */
export function gateSentence(turn: Extract<Turn, { kind: 'gate' }>): string {
  const what =
    turn.artifactVersion === null
      ? turn.gateKind
      : `${turn.gateKind} v${turn.artifactVersion}`
  switch (turn.decision) {
    case 'approved':
      return `Approved the ${what}`
    case 'changes':
      return `Asked for changes to the ${what}`
    case 'reclassify':
      return `Asked for the ${what} to be reclassified`
    case 'rejected':
      return `Rejected the ${what}`
    default:
      return `Waiting on you: the ${what}`
  }
}
