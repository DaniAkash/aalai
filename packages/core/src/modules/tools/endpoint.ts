/**
 * Where the tool surface is reachable, for the stations that hand it to an agent.
 *
 * The run layer must not import the server layer: a station needs an address,
 * not a web framework, and having it reach into the server is how the two stop
 * being separable. The server publishes here when it binds and the stations
 * read it, so the dependency points at this module from both sides.
 */
export interface ToolEndpoint {
  readonly port: number
  readonly token: string | null
}

let endpoint: ToolEndpoint | null = null

export function publishToolEndpoint(next: ToolEndpoint | null): void {
  endpoint = next
}

export function toolEndpoint(): ToolEndpoint | null {
  return endpoint
}

/** Whether a station can be told to record through tools rather than in prose. */
export function toolSurfaceIsUp(): boolean {
  return endpoint !== null
}
