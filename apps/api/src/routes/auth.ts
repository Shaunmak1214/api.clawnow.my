import type { FastifyPluginAsync } from 'fastify'

import { IdentityService } from '../services/identity-service.js'

export const authRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()

  // Clerk handles sign-up and sign-in on the frontend.
  // This endpoint syncs the Clerk user to a local user on first login.
  app.post('/auth/sync', async (request) => {
    const { userId, email, name } = request.body as {
      userId: string
      email: string
      name?: string
    }

    const result = await identityService.syncClerkUser({
      clerkUserId: userId,
      email,
      name: name ?? null,
    })

    return {
      account: result.account,
      user: result.user,
      capabilities: identityService.capabilitiesForUser(result.user),
    }
  })

  app.post('/auth/logout', async (request, reply) => {
    await identityService.logout(request)
    reply.code(204)
    return null
  })
}
