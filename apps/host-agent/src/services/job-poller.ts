import { env } from '../config/env.js'
import { ControlPlaneClient } from '../client/control-plane-client.js'
import { OperationRunner } from './operation-runner.js'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class JobPoller {
  constructor(
    private readonly client = new ControlPlaneClient(),
    private readonly operationRunner = new OperationRunner(),
  ) {}

  async run(vmId: string) {
    while (true) {
      try {
        const jobs = await this.client.claimJobs(vmId)
        for (const job of jobs) {
          const bufferedLogs: Array<{ level: string; message: string }> = []
          const log = async (entry: { level: string; message: string }) => {
            bufferedLogs.push(entry)
            if (bufferedLogs.length >= 5) {
              await this.client.sendLogs(job.id, bufferedLogs.splice(0, bufferedLogs.length))
            }
          }

          try {
            const result = await this.operationRunner.run(job, log)
            await this.client.sendLogs(job.id, bufferedLogs.splice(0, bufferedLogs.length))
            await this.client.completeJob(job.id, result)
          } catch (error) {
            await this.client.sendLogs(job.id, [
              ...bufferedLogs,
              {
                level: 'error',
                message: error instanceof Error ? error.message : 'Unknown job failure',
              },
            ])
            await this.client.failJob(job.id, error instanceof Error ? error.message : 'Unknown job failure')
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown poller error'
        console.error(`[host-agent] ${message}`)
      }

      await sleep(env.POLLING_INTERVAL_MS)
    }
  }
}
