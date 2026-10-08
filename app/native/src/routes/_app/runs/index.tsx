import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { Runs } from '@/screens/runs/Runs'

export const Route = createFileRoute('/_app/runs/')({
  component: () => (
    <ReadingPane>
      <Runs />
    </ReadingPane>
  ),
})
