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

const clerkSyncSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1).optional(),
})

export const authRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()

  app.post('/auth/sync', async (request) => {
    const input = clerkSyncSchema.parse(request.body)
    const result = await identityService.syncClerkUser({
      clerkUserId: input.userId,
      email: input.email,
      name: input.name ?? null,
    })

    return {
      ...result,
      capabilities: identityService.capabilitiesForUser(result.user),
    }
  })

  app.post('/auth/signup', async (request, reply) => {
    const input = signupSchema.parse(request.body)
    const result = await identityService.signup(input)
    identityService.setAuthCookie(reply, result.accessToken)
    reply.code(201)
    return {
      ...result,
      capabilities: identityService.capabilitiesForUser(result.user),
    }
  })

  app.post('/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body)
    const result = await identityService.login(input)
    identityService.setAuthCookie(reply, result.accessToken)
    return {
      ...result,
      capabilities: identityService.capabilitiesForUser(result.user),
    }
  })

  app.post('/auth/logout', async (request, reply) => {
    await identityService.logout(request)
    identityService.clearAuthCookie(reply)
    reply.code(204)
    return null
  })
}
