import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { RailwayInfraProvider } from '../providers/railway-infra-provider.js'
import { IdentityService } from '../services/identity-service.js'
import { InstanceService } from '../services/instance-service.js'

const setupRailwayWebhookSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  url: z.string().trim().url().optional(),
})

function buildDefaultWebhookUrl() {
  return `${env.PUBLIC_API_BASE_URL.replace(/\/+$/, '')}/railway/webhooks`
}

function isLocalWebhookUrl(url: string) {
  const hostname = new URL(url).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0'
}

function pickWebhookSummary(value: unknown) {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const record = value as Record<string, unknown>
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
    deploymentId: typeof record.deploymentId === 'string' ? record.deploymentId : undefined,
    serviceId: typeof record.serviceId === 'string' ? record.serviceId : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
  }
}

export const railwayRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()
  const instanceService = new InstanceService()
  const railwayProvider = new RailwayInfraProvider()

  app.post('/setup-railway-webhook-for-project', async (request, reply) => {
    if (env.INFRA_PROVIDER !== 'railway') {
      throw new HttpError(409, 'Railway webhook setup is only available when INFRA_PROVIDER=railway')
    }

    const { capabilities } = await identityService.requireIdentity(request)
    if (!capabilities.canCreateRailwayService) {
      throw new HttpError(403, 'Railway webhook setup is currently disabled for this account')
    }

    const input = setupRailwayWebhookSchema.parse(request.body ?? {})
    const projectId = input.projectId ?? env.CLAWNOW_RAILWAY_PROJECT_ID
    if (!projectId) {
      throw new HttpError(
        400,
        'projectId is required when CLAWNOW_RAILWAY_PROJECT_ID is not configured',
      )
    }

    const url = input.url ?? buildDefaultWebhookUrl()
    if (!input.url && isLocalWebhookUrl(url)) {
      throw new HttpError(
        400,
        'PUBLIC_API_BASE_URL is not publicly reachable; pass a public webhook url explicitly',
      )
    }

    let result
    try {
      result = await railwayProvider.ensureProjectWebhook({
        projectId,
        url,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/webhookcreate mutation/i.test(message)) {
        throw new HttpError(501, message)
      }
      throw error
    }

    reply.code(result.created ? 201 : 200)
    return {
      ok: true,
      created: result.created,
      webhook: result.webhook,
    }
  })

  app.post('/railway/webhooks', async (request, reply) => {
    const result = await instanceService.handleRailwayWebhook(request.body)

    app.log.info(
      {
        railwayWebhook: {
          headers: {
            'user-agent': request.headers['user-agent'],
            'x-forwarded-for': request.headers['x-forwarded-for'],
          },
          payload: pickWebhookSummary(request.body),
          result,
        },
      },
      'Received Railway webhook',
    )

    reply.code(202)
    return { ok: true, ...result }
  })
}
