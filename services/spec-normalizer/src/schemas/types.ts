import { z } from 'zod'

// ── Zod Schema（运行时校验） ───────────────────────────────
export const FeatureSpecSchema = z.object({
  title: z.string().min(2).max(100),
  goal: z.string().min(5).max(500),
  platform: z.array(z.enum(['client', 'server'])).min(1),
  rules: z.record(z.string()),
  entities: z.array(z.string()).min(1),
  api_contract: z.array(z.object({
    name: z.string(),
    type: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  })).min(1),
  acceptance: z.array(z.string()).min(2),
  priority: z.enum(['high', 'medium', 'low']).default('medium')
})

export function validateSpec(data: unknown) {
  return FeatureSpecSchema.safeParse(data)
}

// ── TypeScript 类型 ─────────────────────────────────────────
export type FeatureSpec = z.infer<typeof FeatureSpecSchema>

export interface DialogueMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface DialogueSession {
  messages: DialogueMessage[]
  round: number
  currentSpec: FeatureSpec | null
}