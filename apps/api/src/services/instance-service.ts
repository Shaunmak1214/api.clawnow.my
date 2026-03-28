import { randomBytes, randomUUID } from 'node:crypto'

import { containerNameForInstance, hostStatePathForInstance, INSTANCE_SIZE_PROFILES, type InstanceSizeProfile } from '@clawnow/core'

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

export class InstanceService {
  constructor(
    private readonly scheduler = new SchedulerService(),
    private readonly vmService = new VmService(),
    private readonly jobService = new OperationJobService(),
    private readonly infra = createInfraProvider(),
  ) {}

  async listInstances(accountId: string) {
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
    const instance = await prisma.openClawInstance.findFirst({
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
    name: string
    region: string
    imageTag: string
    sizeProfile: InstanceSizeProfile
  }) {
    const candidates = await this.vmService.listVmCandidates(input.region)
    const decision = this.scheduler.decidePlacement(candidates, {
      region: input.region,
      sizeProfile: input.sizeProfile,
    })

    const selectedVm =
      decision.action === 'use-existing'
        ? candidates.find((vm) => vm.id === decision.vmId)
        : await this.vmService.ensureVmForRegion(input.region)

    if (!selectedVm) {
      throw new HttpError(500, 'Could not provision or select a VM')
    }

    const profile = INSTANCE_SIZE_PROFILES[input.sizeProfile]
    const sshUsername = generateSshUsername()
    const sshPassword = generateSshPassword()

    const instance = await prisma.openClawInstance.create({
      data: {
        accountId: input.accountId,
        currentVmId: selectedVm.id,
        name: input.name,
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

    const hostStatePath = hostStatePathForInstance(instance.id)
    const volume = await this.infra.createVolume({
      instanceId: instance.id,
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
        message: `Queued deployment for ${input.name}`,
        metadata: {
          region: input.region,
          sizeProfile: input.sizeProfile,
          vmId: selectedVm.id,
        },
      },
    })

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

    return this.getInstance(instance.id, input.accountId)
  }

  async updateInstanceState(input: { accountId: string; instanceId: string; action: 'pause' | 'resume' | 'delete' }) {
    const instance = await this.getInstance(input.instanceId, input.accountId)
    if (!instance.currentVmId) throw new HttpError(409, 'Instance is not placed on a VM')

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
    const currentVm = typeof rest === 'object' && rest !== null && 'currentVm' in rest ? (rest as { currentVm?: { status?: string; publicIp?: string | null } | null }).currentVm : null
    const state = typeof rest === 'object' && rest !== null && 'state' in rest ? (rest as { state?: string }).state : undefined
    const sshReady = Boolean(
      sshPasswordCiphertext &&
        currentVm?.status === 'ACTIVE' &&
        currentVm?.publicIp &&
        state === 'RUNNING',
    )

    return {
      ...rest,
      sshReady,
      sshPassword: sshReady && sshPasswordCiphertext ? decryptSecret(sshPasswordCiphertext) : null,
    }
  }
}
