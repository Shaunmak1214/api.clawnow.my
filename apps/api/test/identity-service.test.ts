import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionCookieOptions } from '../src/services/identity-service.js'

test('session cookies stay insecure for local http development when same-site rules allow it', () => {
  const options = buildSessionCookieOptions({
    apiBaseUrl: 'http://localhost:43180',
    frontendOrigin: 'http://localhost:43100',
    sameSite: 'lax',
    sessionTtlDays: 30,
  })

  assert.equal(options.sameSite, 'lax')
  assert.equal(options.secure, false)
  assert.equal(options.maxAge, 30 * 24 * 60 * 60)
})

test('session cookies force secure mode when configured for cross-site auth flows', () => {
  const options = buildSessionCookieOptions({
    apiBaseUrl: 'http://api.example.test',
    frontendOrigin: 'http://frontend.example.test',
    sameSite: 'none',
    sessionTtlDays: 14,
    domain: '.example.test',
  })

  assert.equal(options.sameSite, 'none')
  assert.equal(options.secure, true)
  assert.equal(options.domain, '.example.test')
  assert.equal(options.maxAge, 14 * 24 * 60 * 60)
})
