import { access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { InstanceService } from '../services/instance-service.js'
import { OperationJobService } from '../services/operation-job-service.js'
import { VmService } from '../services/vm-service.js'

const registerSchema = z.object({
  providerVmId: z.string().min(1).optional(),
  bootstrapToken: z.string().min(1).optional(),
  hostname: z.string().min(1),
  publicIp: z.string().min(1).optional(),
  region: z.string().min(1),
  sizeSlug: z.string().min(1),
  cpuTotalMillicores: z.number().int().positive(),
  memoryTotalMb: z.number().int().positive(),
  diskTotalGb: z.number().int().positive(),
  maxInstances: z.number().int().positive(),
  version: z.string().min(1),
})

const heartbeatSchema = z.object({
  vmId: z.string().min(1).optional(),
  providerVmId: z.string().min(1).optional(),
  hostname: z.string().min(1),
  publicIp: z.string().min(1).optional(),
  region: z.string().min(1),
  sizeSlug: z.string().min(1),
  cpuTotalMillicores: z.number().int().positive(),
  memoryTotalMb: z.number().int().positive(),
  diskTotalGb: z.number().int().positive(),
  maxInstances: z.number().int().positive(),
  version: z.string().min(1),
  cpuUsedPercent: z.number().min(0).max(100),
  memoryUsedMb: z.number().int().min(0),
  diskUsedGb: z.number().int().min(0),
  runningContainers: z.number().int().min(0),
})

const claimSchema = z.object({
  vmId: z.string().min(1),
  limit: z.number().int().min(1).max(25).default(5),
})

const logsSchema = z.object({
  logs: z.array(
    z.object({
      level: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
})

const completeSchema = z.object({
  result: z.record(z.string(), z.unknown()).optional(),
})

const failSchema = z.object({
  errorMessage: z.string().min(1),
})

const accessParamsSchema = z.object({
  id: z.string().min(1),
})

const accessQuerySchema = z.object({
  vmId: z.string().min(1),
})

function assertAgentSecret(header: string | undefined) {
  if (header !== env.AGENT_SHARED_SECRET) {
    throw new HttpError(401, 'Invalid agent secret')
  }
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const vmService = new VmService()
  const jobService = new OperationJobService()
  const instanceService = new InstanceService()
  const agentBundlePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../host-agent/build/host-agent.mjs',
  )

  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/agent')) return
    assertAgentSecret(request.headers['x-agent-secret'] as string | undefined)
  })

  app.post('/agent/register', async (request) => {
    const input = registerSchema.parse(request.body)
    if (!input.providerVmId && !input.bootstrapToken) {
      throw new HttpError(400, 'providerVmId or bootstrapToken is required')
    }

    const vm = await vmService.registerHeartbeat(input)
    return {
      vmId: vm.id,
      pollingIntervalMs: 5000,
    }
  })

  app.post('/agent/heartbeat', async (request) => {
    const input = heartbeatSchema.parse(request.body)
    const vm = await vmService.registerHeartbeat(input)
    return {
      ok: true,
      vmId: vm.id,
    }
  })

  app.post('/agent/jobs/claim', async (request) => {
    const input = claimSchema.parse(request.body)
    const jobs = await jobService.claimJobs(input.vmId, input.limit)
    return {
      jobs: jobs.map((job) => ({
        id: job.id,
        type: job.type,
        vmId: job.vmId,
        instanceId: job.instanceId,
        payload: job.payload,
      })),
    }
  })

  app.post('/agent/jobs/:id/logs', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = logsSchema.parse(request.body)
    await jobService.appendLogs(params.id, input.logs)
    reply.code(202)
    return { ok: true }
  })

  app.post('/agent/jobs/:id/complete', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = completeSchema.parse(request.body)
    await jobService.completeJob(params.id, input.result)
    reply.code(202)
    return { ok: true }
  })

  app.post('/agent/jobs/:id/fail', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = failSchema.parse(request.body)
    await jobService.failJob(params.id, input.errorMessage)
    reply.code(202)
    return { ok: true }
  })

  app.get('/agent/instances/:id/access', async (request) => {
    const params = accessParamsSchema.parse(request.params)
    const query = accessQuerySchema.parse(request.query)
    return instanceService.getAgentAccessCredentials(params.id, query.vmId)
  })

  app.get('/downloads/host-agent.mjs', async (_request, reply) => {
    try {
      await access(agentBundlePath)
    } catch {
      throw new HttpError(503, 'Host-agent bundle is not built yet. Run the host-agent build first.')
    }

    reply.header('Content-Type', 'application/javascript; charset=utf-8')
    return reply.send(createReadStream(agentBundlePath))
  })
}
