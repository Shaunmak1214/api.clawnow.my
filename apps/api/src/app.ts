import Fastify from 'fastify'
import cors from '@fastify/cors'

import { HttpError } from './lib/http-error.js'
import { authRoutes } from './routes/auth.js'
import { agentRoutes } from './routes/agent.js'
import { env } from './config/env.js'
import { healthRoutes } from './routes/health.js'
import { instanceRoutes } from './routes/instances.js'
import { meRoutes } from './routes/me.js'
import { onboardingRoutes } from './routes/onboarding.js'
import { planRoutes } from './routes/plans.js'

export async function createApp() {
  const app = Fastify({
    logger: true,
  })

  await app.register(cors, {
    origin: true,
    credentials: false,
  })

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(meRoutes)
  await app.register(planRoutes)
  await app.register(onboardingRoutes)
  await app.register(instanceRoutes)
  await app.register(agentRoutes)

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
