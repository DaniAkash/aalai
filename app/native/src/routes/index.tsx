import { createFileRoute } from '@tanstack/react-router'
import { Inbox } from '@/screens/inbox/Inbox'

export const Route = createFileRoute('/')({ component: Inbox })
