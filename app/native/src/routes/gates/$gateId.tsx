import { createFileRoute } from '@tanstack/react-router'
import { GateDetail } from '@/screens/gate-detail/GateDetail'

export const Route = createFileRoute('/gates/$gateId')({
  component: GateDetail,
})
