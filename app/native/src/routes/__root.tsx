import { createRootRoute, Outlet } from '@tanstack/react-router'

/**
 * The router root, deliberately empty.
 *
 * Chrome lives on the `_app` layout route instead, so a screen that must not
 * have a sidebar (a first run window, a fatal error) can sit beside it rather
 * than inside it.
 */
export const Route = createRootRoute({
  component: () => <Outlet />,
})
