import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractRailwayWebhookContext,
  isRailwayDeletionConfirmed,
  resolveProviderBackedInstanceTransition,
  resolveRailwayWebhookVmStatus,
  shouldSyncProviderBackedState,
  shouldApplyRailwayWebhookToDeployment,
} from '../src/services/instance-service.js'

test('Railway provisioning transitions to running when the synced VM becomes active', () => {
  const transition = resolveProviderBackedInstanceTransition({
    instanceState: 'PROVISIONING',
    vmStatus: 'ACTIVE',
    infraProvider: 'railway',
  })

  assert.deepEqual(transition, {
    nextState: 'RUNNING',
    eventType: 'deployment.ready',
    eventMessage: 'Your Railway deployment is live and ready to use.',
  })
})

test('Railway provisioning transitions to failed when the synced VM fails', () => {
  const transition = resolveProviderBackedInstanceTransition({
    instanceState: 'PROVISIONING',
    vmStatus: 'FAILED',
    infraProvider: 'railway',
  })

  assert.deepEqual(transition, {
    nextState: 'FAILED',
    eventType: 'deployment.failed',
    eventMessage: 'The Railway deployment failed before OpenClaw finished starting.',
  })
})

test('provider-backed transition helper does not emit duplicate events once provisioning has ended', () => {
  const readyTransition = resolveProviderBackedInstanceTransition({
    instanceState: 'RUNNING',
    vmStatus: 'ACTIVE',
    infraProvider: 'railway',
  })
  const failedTransition = resolveProviderBackedInstanceTransition({
    instanceState: 'FAILED',
    vmStatus: 'FAILED',
    infraProvider: 'railway',
  })

  assert.equal(readyTransition, null)
  assert.equal(failedTransition, null)
})

test('Railway webhook context extraction handles nested deployment payloads', () => {
  const context = extractRailwayWebhookContext({
    event: 'deployment.updated',
    project: { id: 'project-1' },
    service: { id: 'service-1' },
    deployment: {
      id: 'deployment-1',
      status: 'SUCCESS',
    },
  })

  assert.deepEqual(context, {
    projectId: 'project-1',
    serviceId: 'service-1',
    deploymentId: 'deployment-1',
    event: 'deployment.updated',
    status: 'SUCCESS',
  })
})

test('Railway webhook context extraction handles flat payload ids', () => {
  const context = extractRailwayWebhookContext({
    type: 'deployment.crashed',
    projectId: 'project-2',
    serviceId: 'service-2',
    deploymentId: 'deployment-2',
    status: 'CRASHED',
  })

  assert.deepEqual(context, {
    projectId: 'project-2',
    serviceId: 'service-2',
    deploymentId: 'deployment-2',
    event: 'deployment.crashed',
    status: 'CRASHED',
  })
})

test('Railway webhook status resolver ignores removed deployment events', () => {
  assert.equal(
    resolveRailwayWebhookVmStatus({
      instanceState: 'RUNNING',
      status: 'REMOVED',
    }),
    null,
  )
})

test('Railway webhook status resolver does not regress a running instance back to provisioning', () => {
  assert.equal(
    resolveRailwayWebhookVmStatus({
      instanceState: 'RUNNING',
      status: 'DEPLOYING',
    }),
    null,
  )
})

test('Railway webhook status resolver promotes provisioning instances when deploy succeeds', () => {
  assert.equal(
    resolveRailwayWebhookVmStatus({
      instanceState: 'PROVISIONING',
      status: 'SUCCESS',
    }),
    'ACTIVE',
  )
})

test('Railway deletion confirmation detects removed statuses only after deletion finishes', () => {
  assert.equal(
    isRailwayDeletionConfirmed({
      status: 'REMOVED',
    }),
    true,
  )

  assert.equal(
    isRailwayDeletionConfirmed({
      status: 'REMOVING',
    }),
    false,
  )
})

test('Railway deletion confirmation also detects delete events without a status', () => {
  assert.equal(
    isRailwayDeletionConfirmed({
      event: 'service.deleted',
    }),
    true,
  )
})

test('Railway webhook deployment matcher ignores stale deployment ids when an instance tracks a newer deployment', () => {
  assert.equal(
    shouldApplyRailwayWebhookToDeployment({
      currentProviderVmId: 'railway:project-1:env-1:service-1:deployment-new',
      deploymentId: 'deployment-old',
    }),
    false,
  )
})

test('Railway webhook deployment matcher accepts the tracked deployment id', () => {
  assert.equal(
    shouldApplyRailwayWebhookToDeployment({
      currentProviderVmId: 'railway:project-1:env-1:service-1:deployment-new',
      deploymentId: 'deployment-new',
    }),
    true,
  )
})

test('Railway webhook deployment matcher accepts callbacks when the instance has no tracked deployment id yet', () => {
  assert.equal(
    shouldApplyRailwayWebhookToDeployment({
      currentProviderVmId: 'railway:project-1:env-1:service-1',
      deploymentId: 'deployment-new',
    }),
    true,
  )
})

test('provider-backed sync stays enabled for Contabo and disabled for Railway', () => {
  assert.equal(shouldSyncProviderBackedState('contabo'), true)
  assert.equal(shouldSyncProviderBackedState('railway'), false)
})
