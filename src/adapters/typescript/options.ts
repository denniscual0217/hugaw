import { z } from "zod"

/**
 * The adapter owns its config keys; core never learns their names, it just
 * hands over the raw config object (`ResolvedConfig.raw`).
 */
export const tsOptionsSchema = z.object({
  tsconfig: z.string().optional(),
})

export type TsAdapterOptions = z.output<typeof tsOptionsSchema>

export function parseOptions(raw: Record<string, unknown>): TsAdapterOptions {
  const result = tsOptionsSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
    throw new TypeError(`Invalid typescript adapter options — ${detail}`)
  }
  return result.data
}
