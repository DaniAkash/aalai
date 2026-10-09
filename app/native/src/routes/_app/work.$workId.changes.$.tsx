import { createFileRoute } from '@tanstack/react-router'
import { WorkDetail } from '@/screens/work-detail/WorkDetail'

/**
 * The same screen, with one file open in its pane.
 *
 * A splat because a repository path has slashes in it, and the file is part of
 * the url so the view can be sent to somebody rather than described.
 */
export const Route = createFileRoute('/_app/work/$workId/changes/$')({
  component: WorkDetail,
})
