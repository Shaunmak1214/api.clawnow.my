import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRailwayVmSnapshot, mapRailwayDeploymentStatus } from '../src/providers/railway-infra-provider.js'

test('Railway active deployment statuses are treated as ready', () => {
  assert.equal(mapRailwayDeploymentStatus('ACTIVE'), 'ACTIVE')
  assert.equal(mapRailwayDeploymentStatus('SUCCESS'), 'ACTIVE')
  assert.equal(mapRailwayDeploymentStatus('COMPLETED'), 'ACTIVE')
})

test('Railway VM snapshot falls back to the latest deployment state when the original deployment id is unavailable', () => {
  const snapshot = buildRailwayVmSnapshot({
    projectId: 'project-1',
    environmentId: 'env-1',
    serviceId: 'service-1',
    latestDeploymentId: 'deployment-2',
    latestDeploymentStatus: 'SUCCESS',
    publicUrl: 'https://service.up.railway.app',
    serviceName: 'clawnow-service',
  })

  assert.equal(snapshot.providerVmId, 'railway:project-1:env-1:service-1:deployment-2')
  assert.equal(snapshot.status, 'ACTIVE')
  assert.equal(snapshot.publicIp, 'https://service.up.railway.app')
  assert.equal(snapshot.name, 'clawnow-service')
})

test('Railway VM snapshot prefers the latest deployment over an older removed deployment', () => {
  const snapshot = buildRailwayVmSnapshot({
    projectId: 'project-1',
    environmentId: 'env-1',
    serviceId: 'service-1',
    deploymentId: 'deployment-old',
    deploymentStatus: 'REMOVED',
    latestDeploymentId: 'deployment-new',
    latestDeploymentStatus: 'SUCCESS',
    publicUrl: 'https://service.up.railway.app',
    serviceName: 'clawnow-service',
  })

  assert.equal(snapshot.providerVmId, 'railway:project-1:env-1:service-1:deployment-new')
  assert.equal(snapshot.status, 'ACTIVE')
  assert.equal(snapshot.publicIp, 'https://service.up.railway.app')
})
