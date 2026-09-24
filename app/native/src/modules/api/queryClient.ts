import { QueryClient } from '@tanstack/react-query'

/**
 * One cache, reachable from a mutation's own invalidation list.
 *
 * Exported rather than only provided, because every mutation states what it
 * invalidates next to the mutation itself, and doing that through a hook would
 * put the list in the component instead.
 */
export const queryClient = new QueryClient()
