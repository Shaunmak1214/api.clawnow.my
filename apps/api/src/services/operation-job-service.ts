import { Prisma } from '@prisma/client'

import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'

export class OperationJobService {
  private async applySuccessEffects(job: {
    type: string
    instanceId: string | null
  }) {
    if (!job.instanceId) return

    switch (job.type) {
      case 'instance.create':
        await prisma.openClawInstance.update({
          where: { id: job.instanceId },
          data: { state: 'RUNNING' },
        })
        await prisma.instanceEvent.create({
          data: {
            instanceId: job.instanceId,
            type: 'deployment.ready',
            message: 'Instance is now running',
          },
        })
        break
      case 'instance.start':
        await prisma.openClawInstance.update({
          where: { id: job.instanceId },
          data: { state: 'RUNNING' },
        })
        await prisma.instanceEvent.create({
          data: {
            instanceId: job.instanceId,
            type: 'instance.running',
            message: 'Instance has been resumed',
          },
        })
        break
      case 'instance.stop':
        await prisma.openClawInstance.update({
          where: { id: job.instanceId },
          data: { state: 'PAUSED' },
        })
        await prisma.instanceEvent.create({
          data: {
            instanceId: job.instanceId,
            type: 'instance.paused',
            message: 'Instance has been paused',
          },
        })
        break
      case 'telegram.approve':
        await prisma.integration.updateMany({
          where: {
            instanceId: job.instanceId,
            type: 'TELEGRAM',
          },
          data: {
            status: 'ACTIVE',
          },
        })
        await prisma.instanceEvent.create({
          data: {
            instanceId: job.instanceId,
            type: 'telegram.connected',
            message: 'Telegram bot connected',
          },
        })
        break
      case 'pairing.claim':
        await prisma.integration.updateMany({
          where: {
            instanceId: job.instanceId,
            type: 'PAIRING',
          },
          data: {
            status: 'ACTIVE',
          },
        })
        await prisma.instanceEvent.create({
          data: {
            instanceId: job.instanceId,
            type: 'pairing.connected',
            message: 'Pairing code accepted',
          },
        })
        break
      default:
        break
    }
  }

  private async applyFailureEffects(job: {
    type: string
    instanceId: string | null
    errorMessage: string
  }) {
    if (!job.instanceId) return

    switch (job.type) {
      case 'instance.create':
        await prisma.openClawInstance.update({
          where: { id: job.instanceId },
          data: { state: 'FAILED' },
        })
        break
      case 'telegram.approve':
        await prisma.integration.updateMany({
          where: {
            instanceId: job.instanceId,
            type: 'TELEGRAM',
          },
          data: {
            status: 'ERROR',
          },
        })
        break
      case 'pairing.claim':
        await prisma.integration.updateMany({
          where: {
            instanceId: job.instanceId,
            type: 'PAIRING',
          },
          data: {
            status: 'ERROR',
          },
        })
        break
      default:
        break
    }

    await prisma.instanceEvent.create({
      data: {
        instanceId: job.instanceId,
        type: `${job.type}.failed`,
        message: job.errorMessage,
      },
    })
  }

  async createJob(input: {
    vmId: string
    instanceId?: string
    type: string
    payload: Record<string, unknown>
  }) {
    return prisma.operationJob.create({
      data: {
        vmId: input.vmId,
        instanceId: input.instanceId,
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
      },
    })
  }

  async claimJobs(vmId: string, limit = 5) {
    const jobs = await prisma.operationJob.findMany({
      where: {
        vmId,
        status: 'PENDING',
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })

    if (jobs.length === 0) return []

    const ids = jobs.map((job) => job.id)
    await prisma.operationJob.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'CLAIMED',
        claimedAt: new Date(),
      },
    })

    return prisma.operationJob.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'asc' },
    })
  }

  async appendLogs(jobId: string, logs: Array<{ level: string; message: string }>) {
    if (logs.length === 0) return

    await prisma.operationLog.createMany({
      data: logs.map((entry) => ({
        jobId,
        level: entry.level,
        message: entry.message,
      })),
    })
  }

  async completeJob(jobId: string, result?: Record<string, unknown>) {
    const job = await prisma.operationJob.findUnique({ where: { id: jobId } })
    if (!job) throw new HttpError(404, 'Job not found')

    const payload = job.payload as Prisma.JsonObject
    const nextPayload: Prisma.InputJsonValue = result
      ? {
          ...payload,
          result: result as Prisma.InputJsonValue,
        }
      : payload

    await prisma.operationJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        payload: nextPayload,
      },
    })

    await this.applySuccessEffects(job)
  }

  async failJob(jobId: string, errorMessage: string) {
    const job = await prisma.operationJob.findUnique({ where: { id: jobId } })
    if (!job) throw new HttpError(404, 'Job not found')

    await prisma.operationJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage,
        attempts: {
          increment: 1,
        },
      },
    })

    await this.applyFailureEffects({
      type: job.type,
      instanceId: job.instanceId,
      errorMessage,
    })
  }
}
