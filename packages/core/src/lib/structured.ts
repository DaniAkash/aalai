import type { z } from 'zod'

/**
 * Pulls the JSON document out of a station's reply.
 *
 * A station both works and reports, so its reply is prose with a JSON block in
 * it rather than bare JSON. The last fenced block wins, because an agent that
 * revises itself leaves the earlier attempt above the final one.
 */
export function extractJsonBlock(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  const last = fences.at(-1)
  if (last?.[1] !== undefined) {
    return last[1].trim()
  }
  // No fence: fall back to the outermost braces, which covers an agent that
  // returned the object on its own with no commentary around it.
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  return open !== -1 && close > open ? text.slice(open, close + 1) : null
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/** Extracts and validates a station's structured output against its schema. */
export function parseStationOutput<T>(
  text: string,
  schema: z.ZodType<T>,
): Parsed<T> {
  const block = extractJsonBlock(text)
  if (block === null) {
    return { ok: false, error: 'the reply carried no JSON block' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(block)
  } catch (error) {
    return {
      ok: false,
      error: `the JSON block did not parse: ${(error as Error).message}`,
    }
  }
  const result = schema.safeParse(raw)
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error: result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      }
}
