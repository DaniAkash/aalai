import { createFileRoute } from '@tanstack/react-router'
import { Settings } from '@/screens/settings/Settings'

export const Route = createFileRoute('/settings')({ component: Settings })
