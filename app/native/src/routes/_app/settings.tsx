import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { Settings } from '@/screens/settings/Settings'

export const Route = createFileRoute('/_app/settings')({
  component: () => (
    <ReadingPane>
      <Settings />
    </ReadingPane>
  ),
})
