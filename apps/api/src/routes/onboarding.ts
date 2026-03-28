import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { prisma } from '../lib/prisma.js'
import { IdentityService } from '../services/identity-service.js'

const onboardingSchema = z.object({
  businessName: z.string().min(1),
  industry: z.string().min(1).optional(),
  useCase: z.string().optional(),
  channels: z.array(z.string()).default([]),
  skillLevel: z.string().optional(),
  hasApiKeys: z.boolean().optional(),
  hasTelegramBot: z.boolean().optional(),
  expectedUsage: z.string().optional(),
  teamSize: z.string().optional(),
})

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const identityService = new IdentityService()

  app.post('/onboarding', async (request) => {
    const input = onboardingSchema.parse(request.body)
    const { account } = await identityService.ensureDefaultIdentity()

    return prisma.account.update({
      where: { id: account.id },
      data: {
        name: input.businessName,
        industry: input.industry,
        onboardingProfile: input,
      },
    })
  })
}
