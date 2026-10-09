import { gateSentence } from 'aalai/shared'
import { Check, CircleDot, FileText, GitPullRequestArrow } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { Turn } from '@/modules/api/workDetail.hooks'

/**
 * Position is the identity scheme.
 *
 * A person's words sit right in a bubble, a station's work sits left with a
 * byline, and anything the machine did sits centred and quiet. Reading the
 * thread should not require reading the bylines, which matters here because
 * there are four stations and a reporter rather than one assistant.
 */

export function Said({
  turn,
  body,
}: {
  turn: Extract<Turn, { kind: 'said' }>
  body: string
}) {
  if (turn.voice === 'maintainer') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-[var(--radius)] border border-border bg-secondary px-4 py-3">
          <Byline author={turn.author} at={turn.at} you />
          <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-relaxed">
            {body}
          </p>
        </div>
      </div>
    )
  }
  return (
    <Left
      author={turn.author}
      at={turn.at}
      reporter={turn.voice === 'reporter'}
    >
      <p className="m-0 max-w-[68ch] whitespace-pre-wrap text-[13.5px] leading-relaxed">
        {body}
      </p>
    </Left>
  )
}

/**
 * What a station wrote down.
 *
 * The body is not inlined. A plan is long, it is read once and argued with
 * rather than skimmed, and a thread that pastes every version in full stops
 * being a thread. The chip opens it.
 */
export function Recorded({
  turn,
  onOpen,
  active,
  body,
  steps,
  finished,
  runningIndex,
}: {
  turn: Extract<Turn, { kind: 'recorded' }>
  onOpen: () => void
  active: boolean
  /** The text, once the chip has been opened and it has arrived. */
  body?: string
  /** The steps of this plan, when it is the plan in force. */
  steps?: readonly string[]
  /** Which of them a station has finished this session. */
  finished?: ReadonlySet<number>
  /** Which one is running, when one is. */
  runningIndex?: number
}) {
  return (
    <Left author={turn.author} at={turn.at}>
      <p className="m-0 mb-2 text-[13.5px]">
        Recorded the {turn.artifactKind}
        {turn.version > 1 ? `, version ${turn.version}` : ''}.
      </p>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'inline-flex items-center gap-2 rounded-[calc(var(--radius)-4px)] border px-2.5 py-1 font-mono text-[11.5px] transition-colors',
          active
            ? 'border-[color-mix(in_oklab,var(--chart-2)_45%,var(--card))] bg-[color-mix(in_oklab,var(--chart-2)_12%,var(--card))] text-[var(--chart-2)]'
            : 'border-border bg-card hover:border-ring',
        )}
      >
        <FileText className="size-3" />
        {turn.artifactKind}.v{turn.version}
      </button>
      {steps !== undefined && steps.length > 0 ? (
        <ol className="mt-2.5 max-w-[68ch] overflow-hidden rounded-[calc(var(--radius)-2px)] border border-border bg-card">
          {steps.map((step: string, index: number) => (
            <li
              key={step}
              className="flex items-start gap-3 border-border border-b px-3.5 py-2.5 last:border-b-0"
            >
              <StepMark
                index={index}
                done={finished?.has(index) === true}
                running={runningIndex === index}
              />
              <span
                className={cn(
                  'text-[13px] leading-snug',
                  finished?.has(index) === true && 'text-muted-foreground',
                )}
              >
                {step}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {active ? (
        <pre className="mt-2 max-h-[420px] max-w-[72ch] overflow-auto whitespace-pre-wrap rounded-[calc(var(--radius)-2px)] border border-border bg-card px-3.5 py-3 font-mono text-[11.5px] text-muted-foreground leading-relaxed">
          {body ?? 'Reading it.'}
        </pre>
      ) : null}
    </Left>
  )
}

/** Something the machine did, said once and quietly, in the middle. */
export function SystemNote({
  turn,
}: {
  turn: Extract<Turn, { kind: 'gate' }>
}) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-sidebar px-3.5 py-1 text-[12px] text-muted-foreground">
        <CircleDot className="size-3" />
        {gateSentence(turn)}
        {turn.author === 'aalai' ? null : ` by ${turn.author}`}
      </span>
    </div>
  )
}

function Left({
  author,
  at,
  reporter,
  children,
}: {
  author: string
  at: string
  reporter?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <Avatar author={author} reporter={reporter} />
      <div className="min-w-0 flex-1">
        <Byline author={author} at={at} reporter={reporter} />
        {children}
      </div>
    </div>
  )
}

function Byline({
  author,
  at,
  you,
  reporter,
}: {
  author: string
  at: string
  you?: boolean
  reporter?: boolean
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
      <b className="font-semibold text-[12px] text-foreground">
        {you ? 'You' : author}
      </b>
      {reporter ? <span>reported this</span> : null}
      <time dateTime={at}>{when(at)}</time>
    </div>
  )
}

function Avatar({ author, reporter }: { author: string; reporter?: boolean }) {
  return (
    <span
      className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-secondary font-mono font-semibold text-[10px] text-muted-foreground"
      title={author}
    >
      {reporter ? (
        <GitPullRequestArrow className="size-3" />
      ) : (
        author.charAt(0).toUpperCase()
      )}
    </span>
  )
}

/**
 * The time, at the precision a reader of history wants.
 *
 * Minutes for today, because "4 h ago" is how a person refers to something
 * they were part of. A date once it is not today, because "9 days ago" stops
 * being a way anybody locates an event.
 */
function when(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) {
    return ''
  }
  const mins = Math.floor((Date.now() - then.getTime()) / 60_000)
  if (mins < 1) {
    return 'just now'
  }
  if (mins < 60) {
    return `${mins} min ago`
  }
  if (mins < 60 * 24) {
    return `${Math.floor(mins / 60)} h ago`
  }
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Where a step has got to, as one mark that changes rather than three.
 *
 * A number becomes a tick when the step finishes, which is the smallest thing
 * that can say "that one is done" without the row moving or the list reflowing.
 */
function StepMark({
  index,
  done,
  running,
}: {
  index: number
  done: boolean
  running: boolean
}) {
  return (
    <span
      className={cn(
        'mt-px grid size-5 shrink-0 place-items-center rounded-full border font-mono font-semibold text-[10px]',
        done
          ? 'border-primary bg-primary text-primary-foreground'
          : running
            ? 'border-[var(--chart-2)] bg-[var(--chart-2)] text-white'
            : 'border-border bg-secondary text-muted-foreground',
      )}
    >
      {done ? <Check className="size-3" /> : index + 1}
    </span>
  )
}
