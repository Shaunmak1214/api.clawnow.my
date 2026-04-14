import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { prisma } from '../lib/prisma.js'
import { IdentityService } from '../services/identity-service.js'

const onboardingSchema = z.object({
  businessName: z.string().min(1),
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  businessWebsite: z.string().min(1).optional(),
  documents: z
    .array(
      z.object({
        name: z.string().min(1),
        size: z.number().nonnegative(),
        type: z.string().min(1),
      }),
    )
    .default([]),
  agentName: z.string().min(1).optional(),
  agentTone: z.string().min(1).optional(),
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
    const { account } = await identityService.requireIdentity(request)

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
