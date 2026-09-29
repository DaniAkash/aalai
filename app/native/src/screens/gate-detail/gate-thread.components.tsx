import { waitedFor } from 'aalai/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export interface ThreadEntry {
  readonly id: string
  readonly author: string
  readonly role: string
  readonly at: string
  readonly body: string
}

/** "just now" already reads as a time; everything else needs the "ago". */
function said(at: string): string {
  const waited = waitedFor(at)
  return waited === 'just now' ? waited : `${waited} ago`
}

/**
 * What has been said, oldest first.
 *
 * A log rather than a list, so a new entry is announced without stealing focus
 * from whatever the person is typing.
 */
export function Thread({
  entries,
  answering,
  subject = 'the plan',
}: {
  entries: readonly ThreadEntry[]
  answering: boolean
  /** What this gate is about, so the empty state names the right thing. */
  subject?: string
}) {
  if (entries.length === 0 && !answering) {
    return (
      <p
        className="rounded-xl border border-border border-dashed bg-card/40 p-4 text-[13px] text-muted-foreground"
        data-testid="thread-empty"
      >
        No discussion yet. Ask a question, or answer if {subject} looks right.
      </p>
    )
  }

  return (
    <ol
      aria-label="Discussion"
      aria-live="polite"
      className="flex list-none flex-col gap-2"
      data-testid="thread"
      // An ordered list is already the right element; the role makes it a live
      // log so a new entry is announced without stealing focus.
      role="log"
    >
      {entries.map((entry) => (
        <li
          className={`rounded-xl border p-3 ${
            entry.role === 'maintainer'
              ? 'border-primary/35 bg-primary/5'
              : 'border-border bg-card'
          }`}
          data-role={entry.role}
          key={entry.id}
        >
          <p className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{entry.author}</span>
            <span className="rounded border border-border px-1 uppercase tracking-wide">
              {entry.role}
            </span>
            <span>{said(entry.at)}</span>
          </p>
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">
            {entry.body}
          </p>
        </li>
      ))}
      {answering ? (
        <li
          className="rounded-xl border border-border border-dashed bg-card/40 p-3 text-[13px] text-muted-foreground italic"
          data-testid="thread-answering"
        >
          the analyst is answering
        </li>
      ) : null}
    </ol>
  )
}

/**
 * Where a reply is written.
 *
 * Disabled while the analyst is answering, and saying why: a second question
 * arriving mid turn is held until the first is done, so a composer that looked
 * live would be promising something it cannot deliver yet.
 *
 * It survives the gate closing, which is the case worth getting right. Someone
 * else can answer from a terminal while a question is half typed here, and a
 * composer that unmounts on that takes the text with it. Nothing else has a
 * copy, so it stays on screen, disabled, until the person has taken what they
 * wrote.
 */
export function Composer({
  answering,
  gateOpen,
  pending,
  error,
  sentAt,
  station = 'the analyst',
  onSend,
}: {
  answering: boolean
  gateOpen: boolean
  pending: boolean
  error: string | undefined
  /** Changes when a reply is confirmed, which is the only thing that clears the box. */
  sentAt: number
  /** Who is being talked to, which differs by what the gate is about. */
  station?: string
  onSend: (body: string) => void
}) {
  const [body, setBody] = useState('')
  const [clearedAt, setClearedAt] = useState(0)

  // Derived during render rather than in an effect: a confirmed send is the one
  // thing that empties the box, and reacting to it here avoids a frame where the
  // old text is still on screen.
  if (sentAt !== clearedAt) {
    setClearedAt(sentAt)
    setBody('')
  }
  const blocked = answering || pending || !gateOpen
  const empty = body.trim() === ''

  // Nothing to keep and nothing to say: the decision panel already explains
  // what happened to the gate.
  if (!gateOpen && empty) {
    return null
  }

  return (
    <form
      className={`rounded-xl border bg-card ${
        gateOpen ? 'border-border' : 'border-destructive/50'
      }`}
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked || empty) {
          return
        }
        // Not cleared here. The reply can still be refused, by a gate somebody
        // answered while this was being typed, and clearing on submit threw away
        // the text at exactly the moment the person needed it back. The screen
        // clears it once the append is confirmed.
        onSend(body.trim())
      }}
    >
      <label className="sr-only" htmlFor="gate-reply">
        Reply to {station}
      </label>
      <textarea
        className="h-20 w-full resize-none bg-transparent p-3 text-[14px] outline-none disabled:opacity-60"
        disabled={blocked}
        id="gate-reply"
        onChange={(event) => setBody(event.target.value)}
        placeholder={
          answering ? `Waiting for ${station}` : 'Ask, or add a constraint'
        }
        value={body}
      />
      <div className="flex items-center justify-between gap-3 border-border border-t p-2 pl-3">
        <span className="text-[11px] text-muted-foreground">
          {error ?? hint({ answering, gateOpen })}
        </span>
        <Button
          className="min-h-11 min-w-11 lg:min-h-9"
          disabled={blocked || empty}
          size="sm"
          type="submit"
        >
          {pending ? 'Sending' : 'Send'}
        </Button>
      </div>
    </form>
  )
}

/** Why the composer is in the state it is in. */
function hint({
  answering,
  gateOpen,
}: {
  answering: boolean
  gateOpen: boolean
}): string {
  if (!gateOpen) {
    return 'This gate was answered. Your reply was not sent, and is kept here.'
  }
  return answering ? 'Answering' : 'Leaves the gate open'
}
