import { createFileRoute } from '@tanstack/react-router'
import { Queue } from '@/screens/queue/Queue'

export const Route = createFileRoute('/queue')({ component: Queue })
