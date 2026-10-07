import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '@/components/providers/ToastProvider'
import { queryClient } from '@/modules/api/queryClient'
import { routeTree } from './routeTree.gen'
import './index.css'

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('no #root element')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        Providers wrap the router rather than living on a route, so they are
        created once and survive every navigation. A toast raised by a mutation
        outlives the screen that fired it.
      */}
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
