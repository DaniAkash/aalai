import { createFileRoute } from '@tanstack/react-router'
import { WorkDetail } from '@/screens/work-detail/WorkDetail'

export const Route = createFileRoute('/_app/work/$workId')({
  component: WorkDetail,
})
