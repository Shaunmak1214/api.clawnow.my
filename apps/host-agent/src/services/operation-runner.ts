import {
  isApprovedOperation,
  type ClaimedOperationJob,
  type ConfigWritePayload,
  type HealthCheckPayload,
  type InstanceCreatePayload,
  type InstanceLifecyclePayload,
  type LogsCollectPayload,
  type PairingClaimPayload,
  type TelegramApprovePayload,
} from '@clawnow/core'

import { DockerRuntime } from '../runtime/docker-runtime.js'
import { SshAccessManager } from './ssh-access-manager.js'
import { StorageManager } from './storage-manager.js'

type Logger = (entry: { level: string; message: string }) => Promise<void> | void

export class OperationRunner {
  constructor(
    private readonly dockerRuntime = new DockerRuntime(),
    private readonly storageManager = new StorageManager(),
    private readonly sshAccessManager = new SshAccessManager(),
  ) {}

  async run(job: ClaimedOperationJob, log: Logger): Promise<Record<string, unknown> | undefined> {
    if (!isApprovedOperation(job.type)) {
      throw new Error(`Operation ${job.type} is not allowlisted`)
    }

    switch (job.type) {
      case 'instance.create':
        return this.createInstance(job.vmId, job.payload as InstanceCreatePayload, log)
      case 'instance.start':
        return this.startInstance(job.payload as InstanceLifecyclePayload, log)
      case 'instance.stop':
        return this.stopInstance(job.payload as InstanceLifecyclePayload, log)
      case 'instance.restart':
        return this.restartInstance(job.payload as InstanceLifecyclePayload, log)
      case 'instance.remove':
        return this.removeInstance(job.payload as InstanceLifecyclePayload, log)
      case 'telegram.approve':
        return this.telegramApprove(job.payload as TelegramApprovePayload, log)
      case 'pairing.claim':
        return this.pairingClaim(job.payload as PairingClaimPayload, log)
      case 'config.write':
        return this.configWrite(job.payload as ConfigWritePayload, log)
      case 'logs.collect':
        return this.logsCollect(job.payload as LogsCollectPayload, log)
      case 'health.check':
        return this.healthCheck(job.payload as HealthCheckPayload, log)
      default:
        throw new Error(`Unhandled operation ${job.type}`)
    }
  }

  private async createInstance(vmId: string, payload: InstanceCreatePayload, log: Logger) {
    await log({ level: 'info', message: `Preparing storage at ${payload.hostStatePath}` })
    await this.storageManager.ensureInstancePath(payload.hostStatePath)
    await log({ level: 'info', message: `Pulling image ${payload.imageTag}` })
    await this.dockerRuntime.pullImage(payload.imageTag)
    await log({ level: 'info', message: `Removing old container ${payload.containerName} if it exists` })
    await this.dockerRuntime.removeContainer(payload.containerName)
    await log({ level: 'info', message: `Creating container ${payload.containerName}` })
    await this.dockerRuntime.createContainer(payload)
    await log({ level: 'info', message: `Starting container ${payload.containerName}` })
    await this.dockerRuntime.startContainer(payload.containerName)
    await log({ level: 'info', message: `Configuring SSH access for ${payload.sshUsername}` })
    await this.sshAccessManager.configureInstanceAccess({
      instanceId: payload.instanceId,
      vmId,
      sshUsername: payload.sshUsername,
      containerName: payload.containerName,
    })
    return { created: true, containerName: payload.containerName }
  }

  private async startInstance(payload: InstanceLifecyclePayload, log: Logger) {
    await log({ level: 'info', message: `Starting ${payload.containerName}` })
    await this.dockerRuntime.startContainer(payload.containerName)
    return { started: true }
  }

  private async stopInstance(payload: InstanceLifecyclePayload, log: Logger) {
    await log({ level: 'info', message: `Stopping ${payload.containerName}` })
    await this.dockerRuntime.stopContainer(payload.containerName)
    return { stopped: true }
  }

  private async restartInstance(payload: InstanceLifecyclePayload, log: Logger) {
    await log({ level: 'info', message: `Restarting ${payload.containerName}` })
    await this.dockerRuntime.restartContainer(payload.containerName)
    return { restarted: true }
  }

  private async removeInstance(payload: InstanceLifecyclePayload, log: Logger) {
    await log({ level: 'info', message: `Removing ${payload.containerName}` })
    await this.dockerRuntime.removeContainer(payload.containerName)
    await log({ level: 'info', message: `Removing SSH access for ${payload.sshUsername ?? 'unknown-user'}` })
    await this.sshAccessManager.removeInstanceAccess(payload.sshUsername)
    return { removed: true }
  }

  private async telegramApprove(payload: TelegramApprovePayload, log: Logger) {
    await log({ level: 'info', message: `Running telegram approval for ${payload.containerName}` })
    const result = await this.dockerRuntime.exec(payload.containerName, ['openclaw', 'telegram', 'approve'])
    await log({ level: 'info', message: result.stdout.trim() || 'telegram approve completed' })
    return { approved: true }
  }

  private async pairingClaim(payload: PairingClaimPayload, log: Logger) {
    await log({ level: 'info', message: `Claiming pairing code for ${payload.containerName}` })
    const result = await this.dockerRuntime.exec(payload.containerName, ['openclaw', 'pairing', 'claim', payload.pairingCode])
    await log({ level: 'info', message: result.stdout.trim() || 'pairing claim completed' })
    return { claimed: true }
  }

  private async configWrite(payload: ConfigWritePayload, log: Logger) {
    await log({ level: 'info', message: `Writing ${payload.files.length} config file(s)` })
    await this.storageManager.writeFiles(payload)
    return { written: payload.files.length }
  }

  private async logsCollect(payload: LogsCollectPayload, log: Logger) {
    await log({ level: 'info', message: `Collecting logs for ${payload.containerName}` })
    const result = await this.dockerRuntime.logs(payload.containerName, payload.tail)
    return {
      logs: result.stdout || result.stderr,
    }
  }

  private async healthCheck(payload: HealthCheckPayload, log: Logger) {
    await log({ level: 'info', message: `Inspecting health for ${payload.containerName}` })
    const result = await this.dockerRuntime.inspect(payload.containerName)
    return {
      inspect: result.stdout,
    }
  }
}
