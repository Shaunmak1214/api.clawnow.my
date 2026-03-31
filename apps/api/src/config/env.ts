import 'dotenv/config'
import { z } from 'zod'

const optionalUrl = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}, z.string().url().optional())

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:43180'),
  BOOTSTRAP_PUBLIC_API_BASE_URL: optionalUrl,
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:43100'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  AGENT_SHARED_SECRET: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(16),
  JWT_SECRET: z.string().min(16).optional(),
  JWT_EXPIRES_IN: z.string().min(2).default('30d'),
  INSTANCE_PROVISIONING_MODE: z.enum(['manual', 'automatic']).default('automatic'),
  OPENCLAW_DEFAULT_IMAGE_TAG: z.string().min(1).default('latest'),
  SESSION_COOKIE_NAME: z.string().min(1).default('clawnow_session'),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  INFRA_PROVIDER: z.enum(['digitalocean', 'contabo', 'railway']).default('railway'),
  DIGITALOCEAN_TOKEN: z.string().optional(),
  DIGITALOCEAN_DEFAULT_REGION: z.string().default('sgp1'),
  DIGITALOCEAN_DEFAULT_SIZE: z.string().default('s-4vcpu-8gb'),
  DIGITALOCEAN_SSH_KEYS: z.string().optional(),
  CONTABO_CLIENT_ID: z.string().optional(),
  CONTABO_CLIENT_SECRET: z.string().optional(),
  CONTABO_API_USER: z.string().optional(),
  CONTABO_API_PASSWORD: z.string().optional(),
  CONTABO_DEFAULT_REGION: z.string().default('SIN'),
  CONTABO_DEFAULT_PRODUCT_ID: z.string().default('V92'),
  CONTABO_DEFAULT_IMAGE_ID: z.string().optional(),
  CONTABO_SSH_KEY_SECRET_IDS: z.string().optional(),
  CONTABO_ROOT_PASSWORD_SECRET_ID: z.string().optional(),
  CONTABO_CONTRACT_PERIOD_MONTHS: z.coerce.number().int().positive().default(1),
  RAILWAY_API_TOKEN: z.string().optional(),
  RAILWAY_TOKEN_TYPE: z.enum(['project', 'workspace', 'account']).default('project'),
  RAILWAY_GRAPHQL_URL: z.string().url().default('https://backboard.railway.app/graphql/v2'),
  RAILWAY_WORKSPACE_ID: z.string().optional(),
  RAILWAY_PROJECT_ID: z.string().optional(),
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
  RAILWAY_TEMPLATE_REPO: z.string().default('codetitlan/openclaw-railway-template'),
  RAILWAY_TEMPLATE_BRANCH: z.string().default('main'),
  RAILWAY_VOLUME_MOUNT_PATH: z.string().default('/data'),
  RAILWAY_VOLUME_REGION: z.string().optional(),
  RAILWAY_TARGET_PORT: z.coerce.number().int().positive().default(8080),
  RAILWAY_INTERNAL_GATEWAY_PORT: z.coerce.number().int().positive().default(18789),
  BACKUP_PROVIDER: z.enum(['s3']).default('s3'),
  BACKUP_BUCKET: z.string().min(1).default('clawnow-backups'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default('ap-southeast-1'),
})

export const env = envSchema.parse(process.env)
