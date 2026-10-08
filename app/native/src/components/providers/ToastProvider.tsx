import { createContext, type ReactNode, useContext, useMemo } from 'react'
import {
  AnimatedToastStack,
  type ToastInput,
  useAnimatedToastStack,
} from '@/components/motion/animated-toast-stack'

/**
 * One place anything can say something went wrong.
 *
 * A mutation that fails has nowhere of its own to put the reason: the row it
 * came from may have moved, and the screen it came from may have been left.
 * The stack is mounted once in the frame and outlives all of that.
 */

export interface ToastApi {
  show: (input: ToastInput) => string
  /** A failed action, phrased for a person rather than quoting the exception. */
  failed: (what: string, error: unknown) => string
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({
    limit: 3,
    defaultDuration: 6000,
  })

  const api = useMemo<ToastApi>(
    () => ({
      show: showToast,
      failed: (what, error) =>
        showToast({
          status: 'error',
          title: what,
          description: reason(error),
          duration: 8000,
        }),
    }),
    [showToast],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <AnimatedToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        position="bottom-right"
        fixed
      />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside ToastProvider.')
  }
  return context
}

/**
 * The part of a failure worth reading.
 *
 * `Failed to fetch` is what the browser says when the factory is unreachable,
 * which is true and tells a person nothing they can act on.
 */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'Failed to fetch'
    ? 'The factory did not answer. It may have stopped.'
    : message
}
