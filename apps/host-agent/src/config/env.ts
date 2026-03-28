import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  API_BASE_URL: z.string().min(1),
  AGENT_SHARED_SECRET: z.string().min(1),
  PROVIDER_VM_ID: z.string().optional(),
  BOOTSTRAP_TOKEN: z.string().optional(),
  HOSTNAME: z.string().min(1),
  REGION: z.string().min(1),
  SIZE_SLUG: z.string().min(1),
  MAX_INSTANCES: z.coerce.number().int().positive().default(2),
  AGENT_VERSION: z.string().min(1).default('0.1.0'),
  POLLING_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
})

export const env = envSchema.parse(process.env)
