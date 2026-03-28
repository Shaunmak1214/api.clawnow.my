import type { FastifyPluginAsync } from 'fastify'

import { IdentityService } from '../services/identity-service.js'

export const meRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()

  app.get('/me', async () => {
    const { account, user } = await identityService.ensureDefaultIdentity()
    return { account, user }
  })
}
