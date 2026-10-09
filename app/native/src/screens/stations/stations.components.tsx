import { REASONING_EFFORTS, type StationBlurb } from 'aalai/shared'
import { Plus, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'

/** The repeated furniture of the Stations page. */

/**
 * Focus the field the moment it exists.
 *
 * A callback ref rather than autoFocus: this input is created by the press
 * that asked for it, so focus follows an action instead of being taken on
 * load, which is the behaviour the attribute is warned about.
 */
function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus()
}

export function Section({
  icon,
  title,
  blurb,
  children,
}: {
  icon: ReactNode
  title: string
  blurb: string
  children?: ReactNode
}) {
  return (
    <section className="flex gap-4 border-border border-b py-7 last:border-b-0">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[calc(var(--radius)-2px)] border border-border bg-secondary text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-[15px]">{title}</h3>
        <p className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground">
          {blurb}
        </p>
        {children}
      </div>
    </section>
  )
}

export function Field({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: ReactNode
}) {
  return (
    <div className="mt-5">
      <div className="mb-2 font-medium text-[12.5px]">{label}</div>
      {children}
      {help === undefined ? null : (
        <p className="mt-1.5 max-w-[62ch] text-[12px] text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  )
}

/**
 * The skills on one station, added and removed in place.
 *
 * A text field that commits on Enter rather than a modal: a skill is one short
 * name, and a dialog to type one word is a dialog nobody wants twice.
 */
export function SkillTags({
  skills,
  onChange,
  station,
}: {
  skills: readonly string[]
  onChange: (next: string[]) => void
  station: string
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = () => {
    const name = draft.trim()
    // Silently ignoring a duplicate rather than erroring: adding a skill that
    // is already there is a person confirming it, not making a mistake.
    if (name !== '' && !skills.includes(name)) {
      onChange([...skills, name])
    }
    setDraft('')
    setAdding(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {skills.map((skill) => (
        <span
          key={skill}
          className="flex items-center gap-1.5 rounded-full border border-border bg-secondary py-1 pr-1.5 pl-3 text-[12.5px]"
        >
          {skill}
          <button
            type="button"
            aria-label={`Remove ${skill} from the ${station}`}
            onClick={() => onChange(skills.filter((one) => one !== skill))}
            className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          ref={focusOnMount}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit()
            }
            if (event.key === 'Escape') {
              setDraft('')
              setAdding(false)
            }
          }}
          aria-label={`Name a skill for the ${station}`}
          placeholder="skill name"
          className="h-7 w-[140px] rounded-full border border-border bg-background px-3 text-[12.5px] outline-none focus:border-ring"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-full border border-border border-dashed px-3 py-1 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" />
          Add a skill
        </button>
      )}
    </div>
  )
}

/** A small labelled select, as the prototype's inline pills. */
export function Pill({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (next: string) => void
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-[calc(var(--radius)-2px)] border border-border bg-secondary px-2.5 py-1 text-[12.5px]">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="cursor-pointer appearance-none bg-transparent font-mono text-[12px] outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}

export function EffortPill({
  value,
  shared,
  onChange,
}: {
  value: string | undefined
  shared: string
  onChange: (next: string) => void
}) {
  return (
    <Pill
      label="Reasoning effort"
      value={value ?? shared}
      options={REASONING_EFFORTS}
      onChange={onChange}
    />
  )
}

/** What a station cannot do, whatever it is configured with. */
export function Guarantee({ blurb }: { blurb: StationBlurb }) {
  return (
    <p
      className={cn(
        'mt-4 rounded-[calc(var(--radius)-2px)] border border-border border-dashed px-3.5 py-2.5 text-[12px] text-muted-foreground',
      )}
    >
      {blurb.name === 'analyst'
        ? 'A tool here is still read only. Configuring this station does not let it write files.'
        : 'Skills and instructions belong to this station. Adding one here does not give it to the others.'}
    </p>
  )
}
