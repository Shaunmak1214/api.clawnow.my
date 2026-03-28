import type { FastifyPluginAsync } from 'fastify'

import { PlanService } from '../services/plan-service.js'

export const planRoutes: FastifyPluginAsync = async (app) => {
  const planService = new PlanService()

  app.get('/plans', async () => {
    return planService.listPlans()
  })
}
