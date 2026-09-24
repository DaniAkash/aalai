import { createFileRoute } from '@tanstack/react-router'
import { Repos } from '@/screens/repos/Repos'

export const Route = createFileRoute('/repos')({ component: Repos })
