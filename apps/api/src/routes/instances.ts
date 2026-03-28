import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { IdentityService } from '../services/identity-service.js'
import { InstanceService } from '../services/instance-service.js'

const createInstanceSchema = z.object({
  name: z.string().min(1),
  region: z.string().default('sgp1'),
  imageTag: z.string().default('latest'),
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

  app.get('/instances', async () => {
    const { account } = await identityService.ensureDefaultIdentity()
    return instanceService.listInstances(account.id)
  })

  app.post('/instances', async (request, reply) => {
    const input = createInstanceSchema.parse(request.body)
    const { account } = await identityService.ensureDefaultIdentity()
    const instance = await instanceService.createInstance({
      accountId: account.id,
      ...input,
    })
    reply.code(201)
    return instance
  })

  app.get('/instances/:id', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.ensureDefaultIdentity()
    return instanceService.getInstance(params.id, account.id)
  })

  app.get('/instances/:id/events', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.ensureDefaultIdentity()
    return instanceService.listInstanceEvents(params.id, account.id)
  })

  app.post('/instances/:id/pause', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.ensureDefaultIdentity()
    await instanceService.updateInstanceState({
      accountId: account.id,
      instanceId: params.id,
      action: 'pause',
    })
    reply.code(202)
    return { ok: true }
  })

  app.post('/instances/:id/resume', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.ensureDefaultIdentity()
    await instanceService.updateInstanceState({
      accountId: account.id,
      instanceId: params.id,
      action: 'resume',
    })
    reply.code(202)
    return { ok: true }
  })

  app.delete('/instances/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const { account } = await identityService.ensureDefaultIdentity()
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
    const { account } = await identityService.ensureDefaultIdentity()
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
    const { account } = await identityService.ensureDefaultIdentity()
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
    const { account } = await identityService.ensureDefaultIdentity()
    return instanceService.listSshKeys(params.id, account.id)
  })

  app.post('/instances/:id/ssh-keys', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const input = sshKeySchema.parse(request.body)
    const { account, user } = await identityService.ensureDefaultIdentity()
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
    const { account } = await identityService.ensureDefaultIdentity()
    await instanceService.deleteSshKey({
      accountId: account.id,
      instanceId: params.id,
      keyId: params.keyId,
    })
    reply.code(204)
    return null
  })

  app.get('/activity', async () => {
    const { account } = await identityService.ensureDefaultIdentity()
    return instanceService.listActivity(account.id)
  })
}
