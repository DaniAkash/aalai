/**
 * Both shapes of a tool result: prose for the agent, an object for the screen.
 *
 * A tool used to answer only in a sentence, which is fine for the agent and
 * useless to an interface that has to position something from it. Declaring an
 * output schema also means the value is validated on the way out, so a handler
 * that returns the wrong shape fails here rather than rendering as a gap.
 */
import { z } from 'zod'

export function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

export function recordedReply<T extends Record<string, unknown>>(
  body: string,
  value: T,
) {
  return {
    content: [{ type: 'text' as const, text: body }],
    structuredContent: value,
  }
}

/** Every tool that writes an artifact answers with at least this. */
export const artifactWritten = {
  artifactId: z.string(),
  version: z.number().int(),
}
