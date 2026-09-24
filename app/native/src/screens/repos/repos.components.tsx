import type { RunPolicy } from 'aalai-core/shared'

const POLICIES: { value: RunPolicy; label: string; detail: string }[] = [
  {
    value: 'automatic',
    label: 'Automatic',
    detail: 'straight through to a draft pull request',
  },
  {
    value: 'plan_gate',
    label: 'Plan gate',
    detail: 'approve the plan before any code is written',
  },
  {
    value: 'triage',
    label: 'Triage only',
    detail: 'classify and report, never write code',
  },
]

/**
 * How much of a run happens without a person, for one repository.
 *
 * Three buttons rather than a select, because the choice is the whole point of
 * the row and hiding it behind a click makes the current setting invisible
 * until you go looking for it.
 */
export function PolicyPicker({
  value,
  pending,
  onChange,
}: {
  value: RunPolicy
  pending: boolean
  onChange: (policy: RunPolicy) => void
}) {
  return (
    <fieldset
      className="flex shrink-0 overflow-hidden rounded-lg border border-border"
      aria-label="run policy"
    >
      {POLICIES.map((policy) => (
        <button
          key={policy.value}
          type="button"
          title={policy.detail}
          aria-pressed={policy.value === value}
          disabled={pending}
          onClick={() => onChange(policy.value)}
          className={
            policy.value === value
              ? 'bg-primary px-2.5 py-1.5 text-[11.5px] text-primary-foreground'
              : 'px-2.5 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground'
          }
        >
          {policy.label}
        </button>
      ))}
    </fieldset>
  )
}
