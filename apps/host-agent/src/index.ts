import { env } from './config/env.js'
import { HeartbeatService } from './services/heartbeat-service.js'
import { JobPoller } from './services/job-poller.js'

const heartbeatService = new HeartbeatService()
const jobPoller = new JobPoller()

const registration = await heartbeatService.register()

console.log(`[host-agent] registered as vm ${registration.vmId}`)

setInterval(() => {
  heartbeatService.sendHeartbeat(registration.vmId).catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown heartbeat error'
    console.error(`[host-agent] heartbeat failed: ${message}`)
  })
}, Math.min(env.POLLING_INTERVAL_MS, 5000))

await heartbeatService.sendHeartbeat(registration.vmId)
await jobPoller.run(registration.vmId)
