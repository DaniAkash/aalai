import { createFileRoute } from '@tanstack/react-router'
import { Runs } from '@/screens/runs/Runs'

export const Route = createFileRoute('/runs')({ component: Runs })
