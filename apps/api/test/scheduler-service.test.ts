import test from 'node:test'
import assert from 'node:assert/strict'

import { SchedulerService } from '../src/services/scheduler-service.js'

test('scheduler uses an existing healthy VM when capacity is available', () => {
  const scheduler = new SchedulerService()
  const decision = scheduler.decidePlacement(
    [
      {
        id: 'vm-1',
        region: 'sgp1',
        status: 'ACTIVE',
        maxInstances: 2,
        containerCount: 1,
        cpuTotalMillicores: 4000,
        reservedCpuMillicores: 750,
        memoryTotalMb: 8192,
        reservedMemoryMb: 1536,
      },
    ],
    { region: 'sgp1', sizeProfile: 'small' },
  )

  assert.equal(decision.action, 'use-existing')
  assert.equal(decision.vmId, 'vm-1')
})

test('scheduler asks for a new VM when headroom would be violated', () => {
  const scheduler = new SchedulerService()
  const decision = scheduler.decidePlacement(
    [
      {
        id: 'vm-1',
        region: 'sgp1',
        status: 'ACTIVE',
        maxInstances: 2,
        containerCount: 2,
        cpuTotalMillicores: 4000,
        reservedCpuMillicores: 2000,
        memoryTotalMb: 8192,
        reservedMemoryMb: 4096,
      },
    ],
    { region: 'sgp1', sizeProfile: 'medium' },
  )

  assert.equal(decision.action, 'create-vm')
})
