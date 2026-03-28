import test from 'node:test'
import assert from 'node:assert/strict'

import { BootstrapService } from '../src/services/bootstrap-service.js'

test('bootstrap service generates cloud-init with the bootstrap token and download URL', () => {
  const service = new BootstrapService()
  const cloudInit = service.buildCloudInit({
    bootstrapToken: 'token-123',
    hostname: 'clawnow-test',
    region: 'sgp1',
    sizeSlug: 's-4vcpu-8gb',
    maxInstances: 2,
  })

  assert.match(cloudInit, /token-123/)
  assert.match(cloudInit, /downloads\/host-agent\.mjs/)
  assert.match(cloudInit, /clawnow-host-agent\.service/)
})
