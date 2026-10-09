import { createFileRoute } from '@tanstack/react-router'
import { RUN_POLICIES, type RunPolicy } from 'aalai/shared'
import { NewWork } from '@/screens/new-work/NewWork'

/**
 * The search params are validated on the route, which is where router concerns
 * belong: a link carrying a mode this build does not have drops it rather than
 * putting an unknown value in front of the picker.
 */
export const Route = createFileRoute('/_app/work/new')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.repo === 'string' ? { repo: search.repo } : {}),
    ...(isPolicy(search.mode) ? { mode: search.mode } : {}),
    ...(typeof search.from === 'string' ? { from: search.from } : {}),
  }),
  component: NewWork,
})

function isPolicy(value: unknown): value is RunPolicy {
  return (
    typeof value === 'string' &&
    (RUN_POLICIES as readonly string[]).includes(value)
  )
}
