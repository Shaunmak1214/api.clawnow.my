import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { IdentityService } from '../services/identity-service.js'

const signupSchema = z.object({
  businessName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

export const authRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()

  app.post('/auth/signup', async (request, reply) => {
    const input = signupSchema.parse(request.body)
    reply.code(201)
    return identityService.signup(input, reply)
  })

  app.post('/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body)
    return identityService.login(input, reply)
  })

  app.post('/auth/logout', async (request, reply) => {
    await identityService.logout(request, reply)
    reply.code(204)
    return null
  })
}
