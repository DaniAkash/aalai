import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { Inbox } from '@/screens/inbox/Inbox'

export const Route = createFileRoute('/_app/inbox')({
  component: () => (
    <ReadingPane>
      <Inbox />
    </ReadingPane>
  ),
})
