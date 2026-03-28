import { env } from './config/env.js'
import { createApp } from './app.js'

const app = await createApp()

await app.listen({
  host: env.HOST,
  port: env.PORT,
})
