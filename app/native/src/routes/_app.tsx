import { createFileRoute } from '@tanstack/react-router'
import { AppFrame } from '@/components/layout/AppFrame'

/** Everything that gets the sidebar, without adding a path segment. */
export const Route = createFileRoute('/_app')({ component: AppFrame })
