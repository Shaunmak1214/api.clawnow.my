import type { FastifyPluginAsync } from 'fastify'

import { IdentityService } from '../services/identity-service.js'

export const meRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()

  app.get('/me', async (request) => {
    const { account, user, capabilities } = await identityService.requireIdentity(request)
    return { account, user, capabilities }
  })
}
