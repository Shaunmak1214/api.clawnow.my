import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeVmSyncInput } from '../src/services/vm-service.js'

test('vm sync preserves the existing public URL when the provider snapshot omits a fresh one', () => {
  const merged = mergeVmSyncInput(
    {
      providerVmId: 'railway:project:env:service:old-deployment',
      name: 'service-name',
      hostname: 'service-name',
      publicIp: 'https://service.up.railway.app',
      region: 'railway',
      sizeSlug: 'template',
      cpuTotalMillicores: 0,
      memoryTotalMb: 0,
      diskTotalGb: 5,
      maxInstances: 1,
      lastHeartbeatAt: null,
      status: 'PROVISIONING',
    },
    {
      providerVmId: 'railway:project:env:service:new-deployment',
      name: 'service-name',
      hostname: 'service-name',
      region: 'railway',
      sizeSlug: 'template',
      cpuTotalMillicores: 0,
      memoryTotalMb: 0,
      diskTotalGb: 5,
      maxInstances: 1,
      status: 'ACTIVE',
    },
  )

  assert.equal(merged.providerVmId, 'railway:project:env:service:new-deployment')
  assert.equal(merged.publicIp, 'https://service.up.railway.app')
  assert.equal(merged.status, 'ACTIVE')
})
