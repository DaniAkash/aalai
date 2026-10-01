import type { RunPolicy } from 'aalai/shared'
import { Building2, User } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useId } from 'react'
import { cn } from '@/lib/utils'

const GLIDE = { type: 'spring', stiffness: 420, damping: 36 } as const

export interface OwnerOption {
  readonly login: string
  readonly type: 'user' | 'org'
}

/**
 * Which owner the list is showing.
 *
 * One pill that travels, rather than a background on whichever item is active.
 * Where it came from is the useful part: with ten owners the strip scrolls, and
 * a pill that jumps leaves no sense of which scope was left behind.
 */
export function ScopeStrip({
  owners,
  value,
  onChange,
}: {
  owners: readonly OwnerOption[]
  value: string
  onChange: (next: string) => void
}) {
  const layoutId = useId()
  const reduce = useReducedMotion()
  const options = [{ login: 'all', type: 'user' as const }, ...owners]
  return (
    <div
      className="mt-3 flex gap-1 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]"
      role="tablist"
      aria-label="Owner"
    >
      {options.map((owner) => {
        const active = owner.login === value
        const Glyph = owner.type === 'org' ? Building2 : User
        return (
          <button
            key={owner.login}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`scope-${owner.login}`}
            onClick={() => onChange(owner.login)}
            className={cn(
              'relative inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] transition-colors',
              active
                ? 'font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && !reduce ? (
              <motion.span
                layoutId={layoutId}
                transition={GLIDE}
                className="absolute inset-0 rounded-full bg-accent"
              />
            ) : null}
            {active && reduce ? (
              <span className="absolute inset-0 rounded-full bg-accent" />
            ) : null}
            {owner.login === 'all' ? null : (
              <Glyph className="relative size-3" />
            )}
            <span className="relative">
              {owner.login === 'all' ? 'All' : owner.login}
            </span>
          </button>
        )
      })}
    </div>
  )
}

const POLICIES: { value: RunPolicy; label: string; detail: string }[] = [
  {
    value: 'automatic',
    label: 'Automatic',
    detail:
      'Straight through to a draft pull request. Nothing waits for you, and nothing merges either.',
  },
  {
    value: 'plan_gate',
    label: 'Plan gate',
    detail:
      'You approve the plan and the acceptance criteria before any code is written.',
  },
  {
    value: 'triage',
    label: 'Triage only',
    detail:
      'Classify the issue and report back. It never writes code on this repository.',
  },
]

/**
 * How much happens without a person, for the repositories being added.
 *
 * Written explicitly rather than left to the factory default, so a repository
 * is never signed up for unattended pull requests by an inheritance nobody saw.
 * The detail line is always rendered, because the consequence of the choice is
 * the point and a tooltip hides it until after the decision.
 */
export function PolicyChoice({
  value,
  onChange,
}: {
  value: RunPolicy
  onChange: (next: RunPolicy) => void
}) {
  const layoutId = useId()
  const reduce = useReducedMotion()
  const current = POLICIES.find((p) => p.value === value)
  return (
    <div className="border-border border-t px-4 pt-3">
      <div className="mb-2 font-semibold text-[11.5px] text-muted-foreground">
        Policy for the repositories you add
      </div>
      <fieldset
        className="grid grid-cols-1 gap-1 rounded-lg border border-border bg-background p-1 sm:grid-cols-3"
        aria-label="Policy for the repositories you add"
      >
        {POLICIES.map((policy) => {
          const active = policy.value === value
          return (
            <button
              key={policy.value}
              type="button"
              aria-pressed={active}
              data-testid={`policy-${policy.value}`}
              onClick={() => onChange(policy.value)}
              className={cn(
                'relative min-h-9 rounded-md text-[12.5px] transition-colors',
                active
                  ? 'font-semibold text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {active && !reduce ? (
                <motion.span
                  layoutId={layoutId}
                  transition={GLIDE}
                  className="absolute inset-0 rounded-md bg-primary"
                />
              ) : null}
              {active && reduce ? (
                <span className="absolute inset-0 rounded-md bg-primary" />
              ) : null}
              <span className="relative">{policy.label}</span>
            </button>
          )
        })}
      </fieldset>
      <p
        className="mt-2 min-h-8 text-[12px] text-muted-foreground"
        data-testid="policy-detail"
      >
        {value === 'plan_gate' ? (
          <span className="font-semibold text-foreground">The default. </span>
        ) : null}
        {current?.detail}
      </p>
    </div>
  )
}
