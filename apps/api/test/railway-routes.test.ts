import test from 'node:test'
import assert from 'node:assert/strict'

import Fastify from 'fastify'

import { RailwayInfraProvider } from '../src/providers/railway-infra-provider.js'
import { railwayRoutes } from '../src/routes/railway.js'
import { IdentityService } from '../src/services/identity-service.js'
import { InstanceService } from '../src/services/instance-service.js'

test('setup Railway webhook route creates a webhook for an explicit project and url', async () => {
  const originalRequireIdentity = IdentityService.prototype.requireIdentity
  const originalEnsureProjectWebhook = RailwayInfraProvider.prototype.ensureProjectWebhook
  const app = Fastify()
  let capturedInput: { projectId: string; url: string } | null = null

  IdentityService.prototype.requireIdentity = async () =>
    ({
      account: { id: 'account-1' },
      user: { id: 'user-1', email: 'owner@example.com' },
      capabilities: { canCreateRailwayService: true },
    }) as never
  RailwayInfraProvider.prototype.ensureProjectWebhook = async (input) => {
    capturedInput = input

    return {
      created: true,
      webhook: {
        id: 'webhook-1',
        projectId: input.projectId,
        url: input.url,
        lastStatus: 'healthy',
      },
    }
  }

  try {
    await app.register(railwayRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/setup-railway-webhook-for-project',
      payload: {
        projectId: 'project-1',
        url: 'https://api.example.com/railway/webhooks',
      },
    })

    assert.equal(response.statusCode, 201)
    assert.deepEqual(capturedInput, {
      projectId: 'project-1',
      url: 'https://api.example.com/railway/webhooks',
    })
    assert.deepEqual(response.json(), {
      ok: true,
      created: true,
      webhook: {
        id: 'webhook-1',
        projectId: 'project-1',
        url: 'https://api.example.com/railway/webhooks',
        lastStatus: 'healthy',
      },
    })
  } finally {
    IdentityService.prototype.requireIdentity = originalRequireIdentity
    RailwayInfraProvider.prototype.ensureProjectWebhook = originalEnsureProjectWebhook
    await app.close()
  }
})

test('setup Railway webhook route returns 200 when the webhook already exists', async () => {
  const originalRequireIdentity = IdentityService.prototype.requireIdentity
  const originalEnsureProjectWebhook = RailwayInfraProvider.prototype.ensureProjectWebhook
  const app = Fastify()

  IdentityService.prototype.requireIdentity = async () =>
    ({
      account: { id: 'account-1' },
      user: { id: 'user-1', email: 'owner@example.com' },
      capabilities: { canCreateRailwayService: true },
    }) as never
  RailwayInfraProvider.prototype.ensureProjectWebhook = async (input) => ({
    created: false,
    webhook: {
      id: 'webhook-1',
      projectId: input.projectId,
      url: input.url,
      lastStatus: 'healthy',
    },
  })

  try {
    await app.register(railwayRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/setup-railway-webhook-for-project',
      payload: {
        projectId: 'project-1',
        url: 'https://api.example.com/railway/webhooks',
      },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().created, false)
  } finally {
    IdentityService.prototype.requireIdentity = originalRequireIdentity
    RailwayInfraProvider.prototype.ensureProjectWebhook = originalEnsureProjectWebhook
    await app.close()
  }
})

test('setup Railway webhook route enforces the Railway creation capability', async () => {
  const originalRequireIdentity = IdentityService.prototype.requireIdentity
  const app = Fastify()

  IdentityService.prototype.requireIdentity = async () =>
    ({
      account: { id: 'account-1' },
      user: { id: 'user-1', email: 'viewer@example.com' },
      capabilities: { canCreateRailwayService: false },
    }) as never

  try {
    await app.register(railwayRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/setup-railway-webhook-for-project',
      payload: {
        projectId: 'project-1',
        url: 'https://api.example.com/railway/webhooks',
      },
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().message, 'Railway webhook setup is currently disabled for this account')
  } finally {
    IdentityService.prototype.requireIdentity = originalRequireIdentity
    await app.close()
  }
})

test('Railway webhook receiver accepts webhook posts', async () => {
  const originalHandleRailwayWebhook = InstanceService.prototype.handleRailwayWebhook
  const app = Fastify()

  InstanceService.prototype.handleRailwayWebhook = async () => ({
    handled: true,
    matchedInstances: 1,
    appliedInstances: 1,
    projectId: 'project-1',
    serviceId: 'service-1',
    deploymentId: 'deployment-1',
    event: 'deployment.updated',
    status: 'SUCCESS',
  })

  try {
    await app.register(railwayRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/railway/webhooks',
      payload: {
        id: 'deployment-1',
        projectId: 'project-1',
        serviceId: 'service-1',
        status: 'SUCCESS',
      },
    })

    assert.equal(response.statusCode, 202)
    assert.deepEqual(response.json(), {
      ok: true,
      handled: true,
      matchedInstances: 1,
      appliedInstances: 1,
      projectId: 'project-1',
      serviceId: 'service-1',
      deploymentId: 'deployment-1',
      event: 'deployment.updated',
      status: 'SUCCESS',
    })
  } finally {
    InstanceService.prototype.handleRailwayWebhook = originalHandleRailwayWebhook
    await app.close()
  }
})
