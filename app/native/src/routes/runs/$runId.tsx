import { createFileRoute } from '@tanstack/react-router'
import { RunDetail } from '@/screens/run-detail/RunDetail'

export const Route = createFileRoute('/runs/$runId')({ component: RunDetail })
