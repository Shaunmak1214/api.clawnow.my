import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { IdentityService } from '../services/identity-service.js'
import { InstanceService } from '../services/instance-service.js'

const createInstanceSchema = z.object({
  clawName: z.string().trim().min(1),
  region: z.string().default(
    env.INFRA_PROVIDER === 'railway'
      ? 'railway'
      : env.INFRA_PROVIDER === 'contabo'
        ? env.CONTABO_DEFAULT_REGION
        : env.DIGITALOCEAN_DEFAULT_REGION,
  ),
  imageTag: z.string().min(1).optional(),
  sizeProfile: z.enum(['small', 'medium']).default('small'),
})

const telegramSchema = z.object({
  botToken: z.string().min(1),
})

const pairingSchema = z.object({
  pairingCode: z.string().min(1),
})

const sshKeySchema = z.object({
  name: z.string().min(1),
  publicKey: z.string().min(16),
  fingerprint: z.string().min(8),
})

export const instanceRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()
  const instanceService = new InstanceService()

  function assertAutomaticProvisioningMode() {
    if (env.INSTANCE_PROVISIONING_MODE === 'manual') {
      throw new HttpError(403, 'Instance provisioning is disabled in manual mode')
    }
  }

  function assertRailwayCreateAllowed(canCreateRailwayService: boolean) {
    if (env.INFRA_PROVIDER === 'railway' && !canCreateRailwayService) {
      throw new HttpError(403, 'Railway service creation is currently disabled for this account')
    }
  }

  app.get('/instances', async (request) => {
    const { account } = await identityService.requireIdentity(request)
    return instanceService.listInstances(account.id)
  })

  app.post('/instances', async (request, reply) => {
    assertAutomaticProvisioningMode()
    const input = createInstanceSchema.parse(request.body)
    const { account, capabilities } = await identityService.requireIdentity(request)
    assertRailwayCreateAllowed(capabilities.canCreateRailwayService)
    const instance = await instanceService.createInstance({
      accountId: account.id,
      clawName: input.clawName,
      name: input.clawName,
      region: input.region,
      sizeProfile: input.sizeProfile,
      imageTag: input.imageTag ?? env.OPENCLAW_DEFAULT_IMAGE_TAG,
    })
    reply.code(201)
    return instance
  })

  app.get('/instances/:id', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    return instanceService.getInstance(params.id, account.id)
  })

  app.get('/instances/:id/events', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    return instanceService.listInstanceEvents(params.id, account.id)
  })

  app.post('/instances/:id/pause', async (request, reply) => {
    assertAutomaticProvisioningMode()
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    await instanceService.updateInstanceState({
      accountId: account.id,
      instanceId: params.id,
      action: 'pause',
    })
    reply.code(202)
    return { ok: true }
  })

  app.post('/instances/:id/resume', async (request, reply) => {
    assertAutomaticProvisioningMode()
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    await instanceService.updateInstanceState({
      accountId: account.id,
      instanceId: params.id,
      action: 'resume',
    })
    reply.code(202)
    return { ok: true }
  })

  app.delete('/instances/:id', async (request, reply) => {
    assertAutomaticProvisioningMode()
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    await instanceService.updateInstanceState({
      accountId: account.id,
      instanceId: params.id,
      action: 'delete',
    })
    reply.code(202)
    return { ok: true }
  })

  app.post('/instances/:id/integrations/telegram', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = telegramSchema.parse(request.body)
    const { account } = await identityService.requireIdentity(request)
    await instanceService.connectTelegram({
      accountId: account.id,
      instanceId: params.id,
      botToken: input.botToken,
    })
    reply.code(202)
    return { ok: true }
  })

  app.post('/instances/:id/pairing', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = pairingSchema.parse(request.body)
    const { account } = await identityService.requireIdentity(request)
    await instanceService.submitPairing({
      accountId: account.id,
      instanceId: params.id,
      pairingCode: input.pairingCode,
    })
    reply.code(202)
    return { ok: true }
  })

  app.get('/instances/:id/ssh-keys', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    return instanceService.listSshKeys(params.id, account.id)
  })

  app.post('/instances/:id/ssh-keys', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = sshKeySchema.parse(request.body)
    const { account, user } = await identityService.requireIdentity(request)
    const key = await instanceService.addSshKey({
      accountId: account.id,
      userId: user.id,
      instanceId: params.id,
      ...input,
    })
    reply.code(201)
    return key
  })

  app.delete('/instances/:id/ssh-keys/:keyId', async (request, reply) => {
    const params = z.object({ id: z.string().min(1), keyId: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.requireIdentity(request)
    await instanceService.deleteSshKey({
      accountId: account.id,
      instanceId: params.id,
      keyId: params.keyId,
    })
    reply.code(204)
    return null
  })

  app.get('/activity', async (request) => {
    const { account } = await identityService.requireIdentity(request)
    return instanceService.listActivity(account.id)
  })
}
