import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { WorkList } from '@/screens/work-list/WorkList'

export const Route = createFileRoute('/_app/')({
  component: () => (
    <ReadingPane>
      <WorkList />
    </ReadingPane>
  ),
})
