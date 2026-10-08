import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { RunDetail } from '@/screens/run-detail/RunDetail'

export const Route = createFileRoute('/_app/runs/$runId')({
  component: () => (
    <ReadingPane>
      <RunDetail />
    </ReadingPane>
  ),
})
