import {
  type ReasoningEffort,
  STATION_BLURBS,
  type StationBlurb,
} from 'aalai/shared'
import {
  Cpu,
  FileText,
  Hammer,
  ScanEye,
  SearchCode,
  Stethoscope,
} from 'lucide-react'
import {
  AdaptiveStepper,
  AdaptiveStepperDecrement,
  AdaptiveStepperIncrement,
  AdaptiveStepperValue,
} from '@/components/motion/adaptive-stepper'
import { ErrorNote } from '@/components/state'
import { Skeleton } from '@/components/ui/skeleton'
import {
  EffortPill,
  Field,
  Guarantee,
  Pill,
  Section,
  SkillTags,
} from './stations.components'
import { useStations } from './stations.hooks'

/**
 * What each station is given, and how much of this laptop they may use.
 *
 * One page rather than a tab per station, because the thing a person comes
 * here to check is usually a difference between two of them, and a difference
 * you have to click between is one you cannot see.
 */
export function Stations() {
  const {
    settings,
    queue,
    loading,
    failed,
    retry,
    setCeiling,
    setStation,
    setAgent,
  } = useStations()

  if (loading) {
    return <StationsSkeleton />
  }
  if (failed || settings === null) {
    return (
      <div className="mx-auto w-full max-w-[840px] px-4 py-8 md:px-6">
        <ErrorNote message="Could not read your settings." onRetry={retry} />
      </div>
    )
  }

  const running = queue?.running ?? 0

  return (
    <div className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-6">
      <Section
        icon={<Cpu className="size-4" />}
        title="How much this laptop will run at once"
        blurb="aalai is a factory on a machine you are also using. Everything past the ceiling waits in a queue instead of competing for the processor."
      >
        <Field
          label="Parallel runs"
          help={
            running > settings.maxParallelRuns
              ? `${running} are running right now. Lowering the ceiling does not stop them, it stops the next one starting.`
              : 'Four is the ceiling. Past that they compete for the same disk and network rather than going faster.'
          }
        >
          <AdaptiveStepper
            value={settings.maxParallelRuns}
            min={1}
            max={4}
            onValueChange={setCeiling}
            aria-label="Parallel runs"
            className="w-fit"
          >
            <AdaptiveStepperDecrement />
            <AdaptiveStepperValue />
            <AdaptiveStepperIncrement />
          </AdaptiveStepper>
        </Field>
      </Section>

      {STATION_BLURBS.map((blurb) => (
        <StationSection
          key={blurb.name}
          blurb={blurb}
          station={settings.stations[blurb.name]}
          agent={
            blurb.configurableAgent
              ? settings.agents[
                  blurb.name as 'analyst' | 'implementer' | 'reviewer'
                ]
              : undefined
          }
          sharedEffort={settings.reasoningEffort}
          onAgent={(next) =>
            setAgent(blurb.name as 'analyst' | 'implementer' | 'reviewer', next)
          }
          onChange={(change) => setStation(blurb.name, change)}
        />
      ))}

      <Section
        icon={<FileText className="size-4" />}
        title="What every station reads first"
        blurb="Before any station does anything it reads the repository's own instructions. Anything set above is added after them, so a repository can still override you."
      />
    </div>
  )
}

const ICONS = {
  classifier: Stethoscope,
  analyst: SearchCode,
  implementer: Hammer,
  reviewer: ScanEye,
} as const

const AGENTS = ['codex', 'claude', 'gemini'] as const

function StationSection({
  blurb,
  station,
  agent,
  sharedEffort,
  onAgent,
  onChange,
}: {
  blurb: StationBlurb
  station: {
    skills: readonly string[]
    instructions: string
    reasoningEffort?: ReasoningEffort
  }
  agent: string | undefined
  sharedEffort: string
  onAgent: (next: string) => void
  onChange: (change: {
    skills?: string[]
    instructions?: string
    reasoningEffort?: ReasoningEffort
  }) => void
}) {
  const Icon = ICONS[blurb.name]
  return (
    <Section
      icon={<Icon className="size-4" />}
      title={blurb.title}
      blurb={blurb.sentence}
    >
      <Field label="Agent and reasoning effort">
        <div className="flex flex-wrap gap-2">
          {agent === undefined ? (
            <span className="rounded-[calc(var(--radius)-2px)] border border-border border-dashed px-2.5 py-1 font-mono text-[12px] text-muted-foreground">
              built in
            </span>
          ) : (
            <Pill
              label={`Agent for the ${blurb.title}`}
              value={agent}
              options={AGENTS}
              onChange={onAgent}
            />
          )}
          <EffortPill
            value={station.reasoningEffort}
            shared={sharedEffort}
            onChange={(next) =>
              onChange({ reasoningEffort: next as ReasoningEffort })
            }
          />
        </div>
      </Field>

      <Field
        label="Skills"
        help="Skills belong to one station. Adding one here does not give it to the others."
      >
        <SkillTags
          skills={station.skills}
          station={blurb.title}
          onChange={(skills) => onChange({ skills })}
        />
      </Field>

      <Field
        label="Instructions"
        help="Added after the repository's own files, so a repository can still override you."
      >
        <textarea
          defaultValue={station.instructions}
          onBlur={(event) => {
            if (event.target.value !== station.instructions) {
              onChange({ instructions: event.target.value })
            }
          }}
          aria-label={`Instructions for the ${blurb.title}`}
          rows={3}
          className="w-full resize-y rounded-[calc(var(--radius)-2px)] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-ring"
        />
      </Field>

      <Guarantee blurb={blurb} />
    </Section>
  )
}

function StationsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[840px] px-4 py-8 md:px-6">
      <Skeleton className="h-6 w-[52%]" />
      <Skeleton className="mt-3 h-4 w-[76%]" />
      <Skeleton className="mt-6 h-24 w-full rounded-[var(--radius)]" />
      <Skeleton className="mt-4 h-24 w-full rounded-[var(--radius)]" />
    </div>
  )
}
