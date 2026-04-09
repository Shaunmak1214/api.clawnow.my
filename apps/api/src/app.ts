import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'

import { HttpError } from './lib/http-error.js'
import { logger } from './lib/logger.js'
import { authRoutes } from './routes/auth.js'
import { agentRoutes } from './routes/agent.js'
import { env } from './config/env.js'
import { healthRoutes } from './routes/health.js'
import { instanceRoutes } from './routes/instances.js'
import { meRoutes } from './routes/me.js'
import { onboardingRoutes } from './routes/onboarding.js'
import { planRoutes } from './routes/plans.js'
import { railwayRoutes } from './routes/railway.js'

export async function createApp() {
  const app = Fastify({
    loggerInstance: logger,
  })

  await app.register(cors, {
    origin: true,
    credentials: true,
  })
  await app.register(cookie)

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(meRoutes)
  await app.register(planRoutes)
  await app.register(onboardingRoutes)
  await app.register(instanceRoutes)
  await app.register(agentRoutes)
  await app.register(railwayRoutes)

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: error.message,
      })
      return
    }

    if (typeof error === 'object' && error !== null && 'issues' in error) {
      reply.status(400).send({
        error: 'Validation failed',
        details: (error as { issues: unknown }).issues,
      })
      return
    }

    reply.status(500).send({
      error: 'Internal server error',
    })
  })

  return app
}
