import { prisma } from '../lib/prisma.js'

const DEFAULT_PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    monthlyPriceCents: 13900,
    instanceLimit: 1,
    messageLimit: 5000,
    includedChannels: 2,
  },
  {
    key: 'professional',
    name: 'Professional',
    monthlyPriceCents: 23900,
    instanceLimit: 3,
    messageLimit: 50000,
    includedChannels: 999,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    monthlyPriceCents: 0,
    instanceLimit: 999,
    messageLimit: 99999999,
    includedChannels: 999,
  },
] as const

export class PlanService {
  async ensureDefaultPlans() {
    for (const plan of DEFAULT_PLANS) {
      await prisma.plan.upsert({
        where: { key: plan.key },
        update: plan,
        create: plan,
      })
    }
  }

  async listPlans() {
    await this.ensureDefaultPlans()
    return prisma.plan.findMany({
      orderBy: {
        monthlyPriceCents: 'asc',
      },
    })
  }
}
