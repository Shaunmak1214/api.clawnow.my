import { randomBytes, randomUUID } from 'node:crypto'

import { containerNameForInstance, hostStatePathForInstance, INSTANCE_SIZE_PROFILES, type InstanceSizeProfile } from '@clawnow/core'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { prisma } from '../lib/prisma.js'
import { createInfraProvider } from '../providers/infra-provider-factory.js'
import { SchedulerService } from './scheduler-service.js'
import { OperationJobService } from './operation-job-service.js'
import { VmService } from './vm-service.js'

function mapSizeProfile(profile: InstanceSizeProfile) {
  return profile === 'small' ? 'SMALL' : 'MEDIUM'
}

function generateSshUsername() {
  return `claw-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

function generateSshPassword() {
  return randomBytes(18).toString('base64url')
}

function validateRailwayClawName(clawName: string) {
  const normalized = clawName.trim()

  if (!normalized) {
    throw new HttpError(400, 'Claw name is required')
  }

  if (normalized.length < 3 || normalized.length > 63) {
    throw new HttpError(400, 'Claw name must be between 3 and 63 characters')
  }

  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new HttpError(400, 'Claw name may only contain lowercase letters, numbers, and hyphens')
  }

  if (normalized.startsWith('-') || normalized.endsWith('-')) {
    throw new HttpError(400, 'Claw name cannot start or end with a hyphen')
  }

  return normalized
}

function mapRailwayProvisioningError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (normalized.includes('already exists') || normalized.includes('has already been taken') || normalized.includes('duplicate')) {
    return new HttpError(409, 'A Railway service with that Claw name already exists')
  }

  if (normalized.includes('validation') || normalized.includes('invalid')) {
    return new HttpError(400, `Railway rejected this Claw name: ${message}`)
  }

  return null
}

function logRailwayInstance(stage: string, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : ''
  console.info(`[railway-instance] ${stage}${payload}`)
}

function logRailwayInstanceError(stage: string, error: unknown, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : ''
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[railway-instance] ${stage} failed: ${message}${payload}`)
}

export class InstanceService {
  constructor(
    private readonly scheduler = new SchedulerService(),
    private readonly vmService = new VmService(),
    private readonly jobService = new OperationJobService(),
    private readonly infra = createInfraProvider(),
  ) {}

  async listInstances(accountId: string) {
    await this.syncProviderBackedInstances(accountId)
    const instances = await prisma.openClawInstance.findMany({
      where: { accountId },
      include: {
        currentVm: true,
        volume: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return instances.map((instance) => this.serializeInstance(instance))
  }

  async getInstance(instanceId: string, accountId: string) {
    let instance = await prisma.openClawInstance.findFirst({
      where: {
        id: instanceId,
        accountId,
      },
      include: {
        currentVm: true,
        volume: true,
        integrations: true,
      },
    })

    if (!instance) {
      throw new HttpError(404, 'Instance not found')
    }

    await this.syncProviderBackedInstance(instance)

    instance = await prisma.openClawInstance.findFirst({
      where: {
        id: instanceId,
        accountId,
      },
      include: {
        currentVm: true,
        volume: true,
        integrations: true,
      },
    })

    if (!instance) {
      throw new HttpError(404, 'Instance not found')
    }

    return this.serializeInstance(instance)
  }

  async createInstance(input: {
    accountId: string
    clawName?: string
    name: string
    region: string
    imageTag: string
    sizeProfile: InstanceSizeProfile
  }) {
    const instanceName =
      env.INFRA_PROVIDER === 'railway'
        ? validateRailwayClawName(input.clawName || input.name)
        : input.name

    if (env.INFRA_PROVIDER === 'contabo') {
      const existingInstance = await prisma.openClawInstance.findFirst({
        where: {
          accountId: input.accountId,
          state: {
            not: 'DELETING',
          },
        },
      })

      if (existingInstance) {
        throw new HttpError(409, 'Your account already has an OpenClaw instance')
      }
    }

    let decision: {
      action: 'use-existing' | 'create-vm'
      vmId?: string
      reason: string
    } = {
      action: 'create-vm',
      reason:
        env.INFRA_PROVIDER === 'railway'
          ? 'Provision a dedicated Railway service for this OpenClaw instance.'
          : 'Provision a dedicated Contabo VPS for this OpenClaw instance.',
    }
    let selectedVm = null

    if (env.INFRA_PROVIDER === 'contabo' || env.INFRA_PROVIDER === 'railway') {
      try {
        selectedVm = await this.vmService.ensureVmForRegion(input.region, {
          hostname: env.INFRA_PROVIDER === 'railway' ? instanceName : undefined,
        })
      } catch (error) {
        if (env.INFRA_PROVIDER === 'railway') {
          const mapped = mapRailwayProvisioningError(error)
          if (mapped) {
            throw mapped
          }
        }
        throw error
      }
    } else {
      const candidates = await this.vmService.listVmCandidates(input.region)
      decision = this.scheduler.decidePlacement(candidates, {
        region: input.region,
        sizeProfile: input.sizeProfile,
      })
      selectedVm =
        decision.action === 'use-existing'
          ? candidates.find((vm) => vm.id === decision.vmId) ?? null
          : await this.vmService.ensureVmForRegion(input.region)
    }

    if (!selectedVm) {
      throw new HttpError(500, 'Could not provision or select a VM')
    }

    const profile = INSTANCE_SIZE_PROFILES[input.sizeProfile]
    const sshUsername = env.INFRA_PROVIDER === 'railway' ? 'setup' : generateSshUsername()
    const sshPassword = generateSshPassword()

    if (env.INFRA_PROVIDER === 'railway') {
      logRailwayInstance('createInstance.start', {
        accountId: input.accountId,
        name: instanceName,
        region: input.region,
        imageTag: input.imageTag,
        sizeProfile: input.sizeProfile,
        selectedVmId: selectedVm.id,
        providerVmId: selectedVm.providerVmId,
      })
    }

    const instance = await prisma.openClawInstance.create({
      data: {
        accountId: input.accountId,
        currentVmId: selectedVm.id,
        name: instanceName,
        imageTag: input.imageTag,
        sizeProfile: mapSizeProfile(input.sizeProfile),
        reservedCpuMillicores: profile.reservedCpuMillicores,
        reservedMemoryMb: profile.reservedMemoryMb,
        region: input.region,
        state: 'PROVISIONING',
        adminUsername: sshUsername,
        sshPasswordCiphertext: encryptSecret(sshPassword),
        sshPasswordLastRotatedAt: new Date(),
      },
    })

    const hostStatePath =
      env.INFRA_PROVIDER === 'railway'
        ? env.CLAWNOW_RAILWAY_VOLUME_MOUNT_PATH
        : hostStatePathForInstance(instance.id)
    const volume = await this.infra.createVolume({
      instanceId: instance.id,
      providerVmId: selectedVm.providerVmId,
      region: input.region,
      sizeGb: 25,
      mountPath: hostStatePath,
    })

    const createdVolume = await prisma.volume.create({
      data: {
        provider: volume.provider,
        providerVolumeId: volume.providerVolumeId,
        instanceId: instance.id,
        attachedVmId: selectedVm.id,
        region: volume.region,
        sizeGb: volume.sizeGb,
        mountPath: volume.mountPath,
        status: 'ATTACHED',
      },
    })

    await prisma.instancePlacement.create({
      data: {
        instanceId: instance.id,
        vmId: selectedVm.id,
        volumeId: createdVolume.id,
        reason: decision.reason,
        status: 'ACTIVE',
      },
    })

    await prisma.vm.update({
      where: { id: selectedVm.id },
      data: {
        reservedCpuMillicores: {
          increment: profile.reservedCpuMillicores,
        },
        reservedMemoryMb: {
          increment: profile.reservedMemoryMb,
        },
        containerCount: {
          increment: 1,
        },
      },
    })

    await prisma.instanceEvent.create({
      data: {
        instanceId: instance.id,
        type: 'deployment.requested',
        message: `Queued deployment for ${instanceName}`,
        metadata: {
          region: input.region,
          sizeProfile: input.sizeProfile,
          vmId: selectedVm.id,
        },
      },
    })

    if (this.infra.configureInstanceRuntime) {
      try {
        const runtime = await this.infra.configureInstanceRuntime({
          providerVmId: selectedVm.providerVmId,
          instanceId: instance.id,
          name: instanceName,
          region: input.region,
          imageTag: input.imageTag,
          setupPassword: sshPassword,
          mountPath: hostStatePath,
        })

        await prisma.vm.update({
          where: { id: selectedVm.id },
          data: {
            providerVmId: runtime.providerVmId ?? selectedVm.providerVmId,
            publicIp: runtime.publicUrl ?? selectedVm.publicIp,
            status: runtime.status ?? selectedVm.status,
          },
        })

        await prisma.instanceEvent.create({
          data: {
            instanceId: instance.id,
            type: 'deployment.started',
            message: `Started Railway deployment for ${instanceName}`,
            metadata: {
              provider: 'railway',
              publicUrl: runtime.publicUrl,
            },
          },
        })

        if (env.INFRA_PROVIDER === 'railway') {
          logRailwayInstance('createInstance.runtimeConfigured', {
            instanceId: instance.id,
            vmId: selectedVm.id,
            providerVmId: runtime.providerVmId ?? selectedVm.providerVmId,
            publicUrl: runtime.publicUrl ?? null,
            status: runtime.status ?? selectedVm.status,
          })
        }
      } catch (error) {
        if (env.INFRA_PROVIDER === 'railway') {
          logRailwayInstanceError('createInstance.runtimeConfigured', error, {
            instanceId: instance.id,
            vmId: selectedVm.id,
            providerVmId: selectedVm.providerVmId,
          })
          const mapped = mapRailwayProvisioningError(error)
          if (mapped) {
            throw mapped
          }
        }
        throw error
      }
    } else {
      await this.jobService.createJob({
        vmId: selectedVm.id,
        instanceId: instance.id,
        type: 'instance.create',
        payload: {
          instanceId: instance.id,
          containerName: containerNameForInstance(instance.id),
          imageTag: input.imageTag,
          sizeProfile: input.sizeProfile,
          hostStatePath,
          sshUsername,
          env: {
            OPENCLAW_HOME: '/var/lib/openclaw',
            OPENCLAW_STATE_DIR: '/var/lib/openclaw/state',
            OPENCLAW_CONFIG_PATH: '/var/lib/openclaw/state/openclaw.json',
          },
        },
      })
    }

    return this.getInstance(instance.id, input.accountId)
  }

  async updateInstanceState(input: { accountId: string; instanceId: string; action: 'pause' | 'resume' | 'delete' }) {
    const instance = await this.getInstance(input.instanceId, input.accountId)
    if (!instance.currentVmId) throw new HttpError(409, 'Instance is not placed on a VM')

    if (instance.currentVm?.provider === 'RAILWAY') {
      if (input.action !== 'delete') {
        throw new HttpError(409, 'Pause and resume are not supported for Railway deployments yet')
      }

      await prisma.openClawInstance.update({
        where: { id: instance.id },
        data: {
          state: 'DELETING',
        },
      })

      await prisma.instanceEvent.create({
        data: {
          instanceId: instance.id,
          type: 'instance.delete',
          message: 'Deleting Railway project',
        },
      })

      if (instance.currentVm?.providerVmId) {
        await this.infra.deleteVm(instance.currentVm.providerVmId)
      }

      await prisma.vm.update({
        where: { id: instance.currentVmId },
        data: {
          status: 'DELETING',
        },
      })

      return
    }

    const actionToJobType = {
      pause: 'instance.stop',
      resume: 'instance.start',
      delete: 'instance.remove',
    } as const

    const nextState = input.action === 'pause' ? 'PAUSED' : input.action === 'resume' ? 'RUNNING' : 'DELETING'

    await prisma.openClawInstance.update({
      where: { id: instance.id },
      data: {
        state: nextState,
      },
    })

    await prisma.instanceEvent.create({
      data: {
        instanceId: instance.id,
        type: `instance.${input.action}`,
        message: `Queued ${input.action} action`,
      },
    })

    await this.jobService.createJob({
      vmId: instance.currentVmId,
      instanceId: instance.id,
      type: actionToJobType[input.action],
      payload: {
        instanceId: instance.id,
        containerName: containerNameForInstance(instance.id),
        sshUsername: instance.adminUsername,
      },
    })
  }

  async connectTelegram(input: {
    accountId: string
    instanceId: string
    botToken: string
  }) {
    const instance = await this.getInstance(input.instanceId, input.accountId)
    if (!instance.currentVmId) throw new HttpError(409, 'Instance is not placed on a VM')
    if (instance.currentVm?.provider === 'RAILWAY') {
      throw new HttpError(409, 'Telegram automation is not wired up for Railway deployments yet')
    }

    const integration = await prisma.integration.upsert({
      where: {
        instanceId_type: {
          instanceId: instance.id,
          type: 'TELEGRAM',
        },
      },
      update: {
        status: 'PENDING',
        secretCiphertext: encryptSecret(input.botToken),
      },
      create: {
        instanceId: instance.id,
        type: 'TELEGRAM',
        status: 'PENDING',
        secretCiphertext: encryptSecret(input.botToken),
      },
    })

    await prisma.instanceEvent.create({
      data: {
        instanceId: instance.id,
        type: 'telegram.connect.requested',
        message: 'Queued Telegram approval job',
      },
    })

    await this.jobService.createJob({
      vmId: instance.currentVmId,
      instanceId: instance.id,
      type: 'telegram.approve',
      payload: {
        instanceId: instance.id,
        containerName: containerNameForInstance(instance.id),
        botTokenSecretRef: integration.id,
      },
    })
  }

  async submitPairing(input: {
    accountId: string
    instanceId: string
    pairingCode: string
  }) {
    const instance = await this.getInstance(input.instanceId, input.accountId)
    if (!instance.currentVmId) throw new HttpError(409, 'Instance is not placed on a VM')
    if (instance.currentVm?.provider === 'RAILWAY') {
      throw new HttpError(409, 'Pairing automation is not wired up for Railway deployments yet')
    }

    await prisma.integration.upsert({
      where: {
        instanceId_type: {
          instanceId: instance.id,
          type: 'PAIRING',
        },
      },
      update: {
        status: 'PENDING',
        metadata: {
          pairingCode: input.pairingCode,
        },
      },
      create: {
        instanceId: instance.id,
        type: 'PAIRING',
        status: 'PENDING',
        metadata: {
          pairingCode: input.pairingCode,
        },
      },
    })

    await prisma.instanceEvent.create({
      data: {
        instanceId: instance.id,
        type: 'pairing.claim.requested',
        message: 'Queued pairing claim job',
      },
    })

    await this.jobService.createJob({
      vmId: instance.currentVmId,
      instanceId: instance.id,
      type: 'pairing.claim',
      payload: {
        instanceId: instance.id,
        containerName: containerNameForInstance(instance.id),
        pairingCode: input.pairingCode,
      },
    })
  }

  async listInstanceEvents(instanceId: string, accountId: string) {
    await this.getInstance(instanceId, accountId)
    return prisma.instanceEvent.findMany({
      where: { instanceId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async listActivity(accountId: string) {
    return prisma.instanceEvent.findMany({
      where: {
        instance: {
          accountId,
        },
      },
      include: {
        instance: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  }

  async listSshKeys(instanceId: string, accountId: string) {
    await this.getInstance(instanceId, accountId)
    return prisma.sshKey.findMany({
      where: { instanceId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async addSshKey(input: {
    accountId: string
    userId: string
    instanceId: string
    name: string
    publicKey: string
    fingerprint: string
  }) {
    await this.getInstance(input.instanceId, input.accountId)
    return prisma.sshKey.create({
      data: {
        userId: input.userId,
        instanceId: input.instanceId,
        name: input.name,
        publicKey: input.publicKey,
        fingerprint: input.fingerprint,
      },
    })
  }

  async deleteSshKey(input: { accountId: string; instanceId: string; keyId: string }) {
    await this.getInstance(input.instanceId, input.accountId)
    await prisma.sshKey.delete({
      where: {
        id: input.keyId,
      },
    })
  }

  async getAgentAccessCredentials(instanceId: string, vmId: string) {
    const instance = await prisma.openClawInstance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        currentVmId: true,
        adminUsername: true,
        sshPasswordCiphertext: true,
      },
    })

    if (!instance || instance.currentVmId !== vmId) {
      throw new HttpError(404, 'Instance access credentials not found for this VM')
    }

    if (!instance.sshPasswordCiphertext) {
      throw new HttpError(409, 'Instance SSH password is not configured')
    }

    return {
      sshUsername: instance.adminUsername,
      sshPassword: decryptSecret(instance.sshPasswordCiphertext),
    }
  }

  private serializeInstance<T extends { sshPasswordCiphertext?: string | null }>(instance: T) {
    const { sshPasswordCiphertext, ...rest } = instance
    const currentVm =
      typeof rest === 'object' && rest !== null && 'currentVm' in rest
        ? (rest as { currentVm?: { status?: string; publicIp?: string | null; provider?: string } | null }).currentVm
        : null
    const state = typeof rest === 'object' && rest !== null && 'state' in rest ? (rest as { state?: string }).state : undefined
    const provider = currentVm?.provider || null
    const sshReady = Boolean(
      sshPasswordCiphertext &&
        (provider === 'RAILWAY'
          ? currentVm?.publicIp
          : currentVm?.status === 'ACTIVE' &&
            currentVm?.publicIp &&
            state === 'RUNNING'),
    )

    return {
      ...rest,
      accessType: provider === 'RAILWAY' ? 'railway' : 'ssh',
      accessUrl: provider === 'RAILWAY' ? currentVm?.publicIp ?? null : null,
      sshReady,
      sshPassword: sshPasswordCiphertext ? decryptSecret(sshPasswordCiphertext) : null,
    }
  }

  private async syncProviderBackedInstances(accountId: string) {
    if (env.INFRA_PROVIDER !== 'contabo' && env.INFRA_PROVIDER !== 'railway') {
      return
    }

    const instances = await prisma.openClawInstance.findMany({
      where: { accountId },
      include: {
        currentVm: true,
      },
    })

    await Promise.all(
      instances.map((instance) => this.syncProviderBackedInstance(instance)),
    )
  }

  private async syncProviderBackedInstance(
    instance: {
      id: string
      state: string
      currentVm?: {
        id: string
        provider: string
        status: string
        publicIp: string | null
      } | null
    },
  ) {
    if (env.INFRA_PROVIDER !== 'contabo' && env.INFRA_PROVIDER !== 'railway') {
      return
    }

    if (
      !instance.currentVm ||
      (env.INFRA_PROVIDER === 'contabo' && instance.currentVm.provider !== 'CONTABO') ||
      (env.INFRA_PROVIDER === 'railway' && instance.currentVm.provider !== 'RAILWAY')
    ) {
      return
    }

    if (
      instance.state === 'RUNNING' &&
      instance.currentVm.status === 'ACTIVE' &&
      instance.currentVm.publicIp
    ) {
      return
    }

    try {
      const syncedVm = await this.vmService.syncVm(instance.currentVm.id)
      if (!syncedVm) {
        if (env.INFRA_PROVIDER === 'railway') {
          logRailwayInstance('syncProviderBackedInstance.noVm', {
            instanceId: instance.id,
            currentVmId: instance.currentVm.id,
          })
        }
        return
      }

      if (syncedVm.status === 'ACTIVE' && instance.state === 'PROVISIONING') {
        await prisma.openClawInstance.update({
          where: { id: instance.id },
          data: { state: 'RUNNING' },
        })

        await prisma.instanceEvent.create({
          data: {
            instanceId: instance.id,
            type: 'deployment.ready',
            message:
              env.INFRA_PROVIDER === 'railway'
                ? 'Your Railway deployment is live and ready to use.'
                : 'OpenClaw finished bootstrapping and is ready to use.',
          },
        })

        if (env.INFRA_PROVIDER === 'railway') {
          logRailwayInstance('syncProviderBackedInstance.ready', {
            instanceId: instance.id,
            currentVmId: instance.currentVm.id,
            publicIp: syncedVm.publicIp ?? null,
          })
        }
      }

      if (syncedVm.status === 'FAILED' && instance.state === 'PROVISIONING') {
        await prisma.openClawInstance.update({
          where: { id: instance.id },
          data: { state: 'FAILED' },
        })

        await prisma.instanceEvent.create({
          data: {
            instanceId: instance.id,
            type: 'deployment.failed',
            message:
              env.INFRA_PROVIDER === 'railway'
                ? 'The Railway deployment failed before OpenClaw finished starting.'
                : 'The Contabo instance failed before OpenClaw finished bootstrapping.',
          },
        })

        if (env.INFRA_PROVIDER === 'railway') {
          logRailwayInstance('syncProviderBackedInstance.failed', {
            instanceId: instance.id,
            currentVmId: instance.currentVm.id,
          })
        }
      }
    } catch (error) {
      if (env.INFRA_PROVIDER === 'railway') {
        logRailwayInstanceError('syncProviderBackedInstance', error, {
          instanceId: instance.id,
          currentVmId: instance.currentVm.id,
          provider: instance.currentVm.provider,
          state: instance.state,
        })
      }
      return
    }
  }
}
