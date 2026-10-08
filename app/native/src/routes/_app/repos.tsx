import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '@/components/layout/panes'
import { Repos } from '@/screens/repos/Repos'

export const Route = createFileRoute('/_app/repos')({
  component: () => (
    <ReadingPane>
      <Repos />
    </ReadingPane>
  ),
})
