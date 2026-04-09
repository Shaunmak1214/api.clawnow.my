import { randomBytes, randomUUID } from 'node:crypto'

import { containerNameForInstance, hostStatePathForInstance, INSTANCE_SIZE_PROFILES, type InstanceSizeProfile } from '@clawnow/core'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { decryptSecret, encryptSecret } from '../lib/crypto.js'
import { prisma } from '../lib/prisma.js'
import { createInfraProvider } from '../providers/infra-provider-factory.js'
import { mapRailwayDeploymentStatus, parseRailwayProviderVmId } from '../providers/railway-infra-provider.js'
import { SchedulerService } from './scheduler-service.js'
import { OperationJobService } from './operation-job-service.js'
import { VmService } from './vm-service.js'
import type { VmStatus } from '@prisma/client'

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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function findRailwayEntityId(value: unknown, directKey: string, nestedKey: string): string | undefined {
  const object = asObject(value)
  if (!object) {
    return undefined
  }

  const directValue = asString(object[directKey])
  if (directValue) {
    return directValue
  }

  const nestedValue = asObject(object[nestedKey])
  const nestedId = nestedValue ? asString(nestedValue.id) : undefined
  if (nestedId) {
    return nestedId
  }

  for (const entry of Object.values(object)) {
    const match = findRailwayEntityId(entry, directKey, nestedKey)
    if (match) {
      return match
    }
  }

  return undefined
}

function findRailwayEventName(value: unknown): string | undefined {
  const object = asObject(value)
  if (!object) {
    return undefined
  }

  for (const key of ['event', 'eventType', 'type']) {
    const directValue = asString(object[key])
    if (directValue) {
      return directValue
    }
  }

  for (const entry of Object.values(object)) {
    const match = findRailwayEventName(entry)
    if (match) {
      return match
    }
  }

  return undefined
}

function findRailwayDeploymentStatus(value: unknown): string | undefined {
  const object = asObject(value)
  if (!object) {
    return undefined
  }

  const directValue = asString(object.status)
  if (directValue) {
    return directValue
  }

  const deploymentValue = asObject(object.deployment)
  const deploymentStatus = deploymentValue ? asString(deploymentValue.status) : undefined
  if (deploymentStatus) {
    return deploymentStatus
  }

  for (const entry of Object.values(object)) {
    const match = findRailwayDeploymentStatus(entry)
    if (match) {
      return match
    }
  }

  return undefined
}

function normalizeRailwayEvent(value?: string) {
  return (value || '').trim().toLowerCase()
}

export function extractRailwayWebhookContext(payload: unknown) {
  return {
    projectId: findRailwayEntityId(payload, 'projectId', 'project'),
    serviceId: findRailwayEntityId(payload, 'serviceId', 'service'),
    deploymentId: findRailwayEntityId(payload, 'deploymentId', 'deployment'),
    event: findRailwayEventName(payload),
    status: findRailwayDeploymentStatus(payload),
  }
}

export function isRailwayDeletionConfirmed(input: {
  event?: string
  status?: string
}) {
  const normalizedStatus = (input.status || '').trim().toUpperCase()
  if (normalizedStatus === 'REMOVED' || normalizedStatus === 'DELETED' || normalizedStatus === 'DESTROYED') {
    return true
  }

  const normalizedEvent = normalizeRailwayEvent(input.event)
  return (
    normalizedEvent.includes('removed') ||
    normalizedEvent.includes('deleted') ||
    normalizedEvent.includes('destroyed')
  )
}

export function resolveRailwayWebhookVmStatus(input: {
  instanceState: string
  status?: string
}): VmStatus | null {
  if (!input.status) {
    return null
  }

  const mappedStatus = mapRailwayDeploymentStatus(input.status) as VmStatus

  if (mappedStatus === 'OFFLINE') {
    return null
  }

  if (input.instanceState !== 'PROVISIONING' && mappedStatus !== 'ACTIVE') {
    return null
  }

  return mappedStatus
}

export function shouldApplyRailwayWebhookToDeployment(input: {
  currentProviderVmId: string
  deploymentId?: string
}) {
  if (!input.deploymentId) {
    return true
  }

  try {
    const currentProviderVm = parseRailwayProviderVmId(input.currentProviderVmId)
    if (!currentProviderVm.deploymentId) {
      return true
    }

    return currentProviderVm.deploymentId === input.deploymentId
  } catch {
    return true
  }
}

function matchesRailwayWebhookContext(
  currentProviderVmId: string,
  context: {
    projectId?: string
    serviceId?: string
    deploymentId?: string
  },
) {
  try {
    const currentProviderVm = parseRailwayProviderVmId(currentProviderVmId)

    if (context.projectId && currentProviderVm.projectId !== context.projectId) {
      return false
    }

    if (context.serviceId && currentProviderVm.serviceId !== context.serviceId) {
      return false
    }

    if (
      context.deploymentId &&
      currentProviderVm.deploymentId &&
      currentProviderVm.deploymentId !== context.deploymentId
    ) {
      return false
    }

    return Boolean(context.projectId || context.serviceId || context.deploymentId)
  } catch {
    return false
  }
}

export function resolveProviderBackedInstanceTransition(input: {
  instanceState: string
  vmStatus: string
  infraProvider: 'contabo' | 'railway'
}) {
  if (input.instanceState !== 'PROVISIONING') {
    return null
  }

  if (input.vmStatus === 'ACTIVE') {
    return {
      nextState: 'RUNNING' as const,
      eventType: 'deployment.ready',
      eventMessage:
        input.infraProvider === 'railway'
          ? 'Your Railway deployment is live and ready to use.'
          : 'OpenClaw finished bootstrapping and is ready to use.',
    }
  }

  if (input.vmStatus === 'FAILED') {
    return {
      nextState: 'FAILED' as const,
      eventType: 'deployment.failed',
      eventMessage:
        input.infraProvider === 'railway'
          ? 'The Railway deployment failed before OpenClaw finished starting.'
          : 'The Contabo instance failed before OpenClaw finished bootstrapping.',
    }
  }

  return null
}

export function shouldSyncProviderBackedState(infraProvider: string) {
  return infraProvider === 'contabo'
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

        if (runtime.gatewayToken) {
          await prisma.openClawInstance.update({
            where: { id: instance.id },
            data: {
              gatewayTokenCiphertext: encryptSecret(runtime.gatewayToken),
            },
          })
        }

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

      if (!instance.currentVm?.providerVmId) {
        throw new HttpError(409, 'Railway deployment is missing its provider service id')
      }

      await this.infra.deleteVm(instance.currentVm.providerVmId)

      await this.finalizeRailwayInstanceDeletion({
        instanceId: instance.id,
        vmId: instance.currentVmId,
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

  private serializeInstance<T extends { sshPasswordCiphertext?: string | null; gatewayTokenCiphertext?: string | null }>(instance: T) {
    const { sshPasswordCiphertext, gatewayTokenCiphertext, ...rest } = instance
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
      gatewayToken: gatewayTokenCiphertext ? decryptSecret(gatewayTokenCiphertext) : null,
    }
  }

  async handleRailwayWebhook(payload: unknown) {
    const context = extractRailwayWebhookContext(payload)
    const isDeletionConfirmed = isRailwayDeletionConfirmed({
      event: context.event,
      status: context.status,
    })

    if (env.INFRA_PROVIDER !== 'railway') {
      return {
        handled: false,
        reason: 'infra-provider-not-railway',
        ...context,
      }
    }

    if (!context.projectId || !context.serviceId) {
      if (!isDeletionConfirmed) {
        logRailwayInstance('handleRailwayWebhook.ignored', {
          reason: 'missing-project-or-service',
          ...context,
        })

        return {
          handled: false,
          reason: 'missing-project-or-service',
          ...context,
        }
      }
    }

    const railwayInstances = await prisma.openClawInstance.findMany({
      where: {
        currentVm: {
          is: {
            provider: 'RAILWAY',
          },
        },
      },
      include: {
        currentVm: true,
      },
    })

    const deletingRailwayInstances = railwayInstances.filter(
      (instance) => instance.state === 'DELETING' && instance.currentVm,
    )

    if (!context.projectId || !context.serviceId) {
      let deletionFallbackMatches = deletingRailwayInstances.filter((instance) =>
        instance.currentVm
          ? matchesRailwayWebhookContext(instance.currentVm.providerVmId, context)
          : false,
      )

      if (
        deletionFallbackMatches.length === 0 &&
        !context.projectId &&
        !context.serviceId &&
        !context.deploymentId &&
        deletingRailwayInstances.length === 1
      ) {
        deletionFallbackMatches = deletingRailwayInstances
      }

      if (deletionFallbackMatches.length === 0) {
        logRailwayInstance('handleRailwayWebhook.ignored', {
          reason: 'missing-project-or-service',
          ...context,
        })

        return {
          handled: false,
          reason: 'missing-project-or-service',
          ...context,
        }
      }

      await Promise.all(
        deletionFallbackMatches.map(async (instance) => {
          if (!instance.currentVm) {
            return
          }

          await this.finalizeRailwayInstanceDeletion({
            instanceId: instance.id,
            vmId: instance.currentVm.id,
          })
        }),
      )

      logRailwayInstance('handleRailwayWebhook.syncedDeletionFallback', {
        matchedInstances: deletionFallbackMatches.length,
        appliedInstances: deletionFallbackMatches.length,
        ...context,
      })

      return {
        handled: true,
        matchedInstances: deletionFallbackMatches.length,
        appliedInstances: deletionFallbackMatches.length,
        ...context,
      }
    }

    const matchingInstances = railwayInstances.filter((instance) => {
      if (!instance.currentVm) {
        return false
      }

      return matchesRailwayWebhookContext(instance.currentVm.providerVmId, context)
    })

    if (matchingInstances.length === 0) {
      const deletingMatches = deletingRailwayInstances.filter((instance) =>
        instance.currentVm
          ? matchesRailwayWebhookContext(instance.currentVm.providerVmId, context)
          : false,
      )

      if (isDeletionConfirmed && deletingMatches.length > 0) {
        await Promise.all(
          deletingMatches.map(async (instance) => {
            if (!instance.currentVm) {
              return
            }

            await this.finalizeRailwayInstanceDeletion({
              instanceId: instance.id,
              vmId: instance.currentVm.id,
            })
          }),
        )

        logRailwayInstance('handleRailwayWebhook.syncedDeletionMatch', {
          matchedInstances: deletingMatches.length,
          appliedInstances: deletingMatches.length,
          ...context,
        })

        return {
          handled: true,
          matchedInstances: deletingMatches.length,
          appliedInstances: deletingMatches.length,
          ...context,
        }
      }

      logRailwayInstance('handleRailwayWebhook.unmatched', context)

      return {
        handled: false,
        reason: 'no-matching-instance',
        matchedInstances: 0,
        ...context,
      }
    }

    let appliedInstances = 0

    await Promise.all(
      matchingInstances.map(async (instance) => {
        if (!instance.currentVm) {
          return
        }

        if (
          instance.state === 'DELETING' &&
          isDeletionConfirmed
        ) {
          await this.finalizeRailwayInstanceDeletion({
            instanceId: instance.id,
            vmId: instance.currentVm.id,
          })
          appliedInstances += 1
          return
        }

        let expectedDeploymentId: string | undefined
        try {
          expectedDeploymentId = parseRailwayProviderVmId(instance.currentVm.providerVmId).deploymentId
        } catch {
          expectedDeploymentId = undefined
        }

        if (
          !shouldApplyRailwayWebhookToDeployment({
            currentProviderVmId: instance.currentVm.providerVmId,
            deploymentId: context.deploymentId,
          })
        ) {
          logRailwayInstance('handleRailwayWebhook.ignoredDeployment', {
            instanceId: instance.id,
            currentVmId: instance.currentVm.id,
            expectedDeploymentId: expectedDeploymentId || null,
            deploymentId: context.deploymentId,
            event: context.event || null,
            status: context.status || null,
          })
          return
        }

        const nextVmStatus = resolveRailwayWebhookVmStatus({
          instanceState: instance.state,
          status: context.status,
        })

        if (!nextVmStatus) {
          if (context.status) {
            logRailwayInstance('handleRailwayWebhook.ignoredStatus', {
              instanceId: instance.id,
              currentVmId: instance.currentVm.id,
              state: instance.state,
              status: context.status,
              event: context.event || null,
              deploymentId: context.deploymentId || null,
            })
          }
          return
        }

        const providerVm = parseRailwayProviderVmId(instance.currentVm.providerVmId)
        const nextProviderVmId =
          nextVmStatus === 'ACTIVE' && context.deploymentId
            ? `railway:${providerVm.projectId}:${providerVm.environmentId}:${providerVm.serviceId}:${context.deploymentId}`
            : instance.currentVm.providerVmId

        const syncedVm = await prisma.vm.update({
          where: { id: instance.currentVm.id },
          data: {
            status: nextVmStatus,
            providerVmId: nextProviderVmId,
          },
        })

        appliedInstances += 1

        const transition = resolveProviderBackedInstanceTransition({
          instanceState: instance.state,
          vmStatus: syncedVm.status,
          infraProvider: 'railway',
        })

        if (!transition) {
          return
        }

        await prisma.openClawInstance.update({
          where: { id: instance.id },
          data: { state: transition.nextState },
        })

        await prisma.instanceEvent.create({
          data: {
            instanceId: instance.id,
            type: transition.eventType,
            message: transition.eventMessage,
          },
        })
      }),
    )

    logRailwayInstance('handleRailwayWebhook.synced', {
      matchedInstances: matchingInstances.length,
      appliedInstances,
      ...context,
    })

    return {
      handled: true,
      matchedInstances: matchingInstances.length,
      appliedInstances,
      ...context,
    }
  }

  private async syncProviderBackedInstances(accountId: string) {
    if (env.INFRA_PROVIDER === 'railway') {
      const deletingInstances = await prisma.openClawInstance.findMany({
        where: {
          accountId,
          state: 'DELETING',
        },
        include: {
          currentVm: true,
        },
      })

      await Promise.all(
        deletingInstances.map((instance) => this.syncDeletingRailwayInstance(instance)),
      )

      return
    }

    if (!shouldSyncProviderBackedState(env.INFRA_PROVIDER)) {
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

  private async syncDeletingRailwayInstance(
    instance: {
      id: string
      state: string
      currentVm?: {
        id: string
        provider: string
        providerVmId: string
      } | null
    },
  ) {
    if (
      env.INFRA_PROVIDER !== 'railway' ||
      instance.state !== 'DELETING' ||
      !instance.currentVm ||
      instance.currentVm.provider !== 'RAILWAY'
    ) {
      return
    }

    try {
      const providerVm = await this.infra.getVm(instance.currentVm.providerVmId)
      if (providerVm && providerVm.status !== 'OFFLINE') {
        return
      }

      await this.finalizeRailwayInstanceDeletion({
        instanceId: instance.id,
        vmId: instance.currentVm.id,
      })
    } catch {
      return
    }
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
    if (!shouldSyncProviderBackedState(env.INFRA_PROVIDER)) {
      return
    }

    if (
      !instance.currentVm ||
      (env.INFRA_PROVIDER === 'contabo' && instance.currentVm.provider !== 'CONTABO')
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
        return
      }

      const transition = resolveProviderBackedInstanceTransition({
        instanceState: instance.state,
        vmStatus: syncedVm.status,
        infraProvider: env.INFRA_PROVIDER,
      })

      if (transition) {
        await prisma.openClawInstance.update({
          where: { id: instance.id },
          data: { state: transition.nextState },
        })

        await prisma.instanceEvent.create({
          data: {
            instanceId: instance.id,
            type: transition.eventType,
            message: transition.eventMessage,
          },
        })
      }
    } catch (error) {
      return
    }
  }

  private async finalizeRailwayInstanceDeletion(input: {
    instanceId: string
    vmId: string
  }) {
    await prisma.$transaction(async (tx) => {
      const instance = await tx.openClawInstance.findUnique({
        where: { id: input.instanceId },
        select: { id: true },
      })

      if (!instance) {
        return
      }

      await tx.openClawInstance.delete({
        where: { id: input.instanceId },
      })

      await tx.vm.deleteMany({
        where: { id: input.vmId },
      })
    })
  }
}
