import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { Queue } from '@/screens/queue/Queue'

export const Route = createFileRoute('/_app/queue')({
  component: () => (
    <ReadingPane>
      <Queue />
    </ReadingPane>
  ),
})
