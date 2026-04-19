import test from 'node:test'
import assert from 'node:assert/strict'

import { HttpError } from '../src/lib/http-error.js'
import { prisma } from '../src/lib/prisma.js'
import { IdentityService, buildSessionCookieOptions } from '../src/services/identity-service.js'

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

test('syncClerkUser binds an existing email/password account to the incoming Clerk user', async () => {
  const service = new IdentityService()
  const existingUser = {
    id: 'user_legacy',
    accountId: 'acct_1',
    email: 'legacy@example.com',
    clerkUserId: null,
    passwordHash: 'hashed-password',
    name: 'Legacy User',
    account: {
      id: 'acct_1',
      name: 'Legacy Workspace',
    },
  }

  const originalUserFindUnique = prisma.user.findUnique
  const originalUserUpdate = prisma.user.update

  prisma.user.findUnique = (async (args: { where: { clerkUserId?: string; email?: string } }) => {
    if (args.where.clerkUserId === 'clerk_123') {
      return null
    }

    if (args.where.email === 'legacy@example.com') {
      return existingUser
    }

    return null
  }) as unknown as typeof prisma.user.findUnique

  prisma.user.update = (async (args: { where: { id: string }; data: { clerkUserId?: string; email?: string; name?: string | null } }) => ({
    ...existingUser,
    ...args.data,
  })) as unknown as typeof prisma.user.update

  try {
    const result = await service.syncClerkUser({
      clerkUserId: 'clerk_123',
      email: 'legacy@example.com',
      name: 'Legacy User',
    })

    assert.equal(result.user.id, 'user_legacy')
    assert.equal(result.user.email, 'legacy@example.com')
    assert.equal(result.account.id, 'acct_1')
    assert.equal(typeof result.accessToken, 'string')
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.user.update = originalUserUpdate
  }
})

test('syncClerkUser rejects a Clerk identity whose email belongs to a different user', async () => {
  const service = new IdentityService()
  const clerkBoundUser = {
    id: 'user_clerk',
    accountId: 'acct_clerk',
    email: 'clerk@example.com',
    clerkUserId: 'clerk_123',
    passwordHash: '',
    name: 'Clerk User',
    account: {
      id: 'acct_clerk',
      name: 'Clerk Workspace',
    },
  }

  const originalUserFindUnique = prisma.user.findUnique

  prisma.user.findUnique = (async (args: {
    where: { clerkUserId?: string; email?: string }
    select?: { id: true }
  }) => {
    if (args.where.clerkUserId === 'clerk_123') {
      return clerkBoundUser
    }

    if (args.where.email === 'legacy@example.com') {
      return { id: 'user_legacy' }
    }

    return null
  }) as unknown as typeof prisma.user.findUnique

  try {
    await assert.rejects(
      service.syncClerkUser({
        clerkUserId: 'clerk_123',
        email: 'legacy@example.com',
        name: 'Legacy User',
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.message === 'This email is already linked to another account',
    )
  } finally {
    prisma.user.findUnique = originalUserFindUnique
  }
})
