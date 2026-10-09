import { createFileRoute } from '@tanstack/react-router'
import { Stations } from '@/screens/stations/Stations'

export const Route = createFileRoute('/_app/stations')({
  component: Stations,
})
