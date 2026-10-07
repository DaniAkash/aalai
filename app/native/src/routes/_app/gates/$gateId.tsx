import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { GateDetail } from '@/screens/gate-detail/GateDetail'

export const Route = createFileRoute('/_app/gates/$gateId')({
  component: () => (
    <ReadingPane>
      <GateDetail />
    </ReadingPane>
  ),
})
