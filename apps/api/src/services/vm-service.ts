import { randomUUID } from 'node:crypto'

import { env } from '../config/env.js'
import { prisma } from '../lib/prisma.js'
import type { Provider } from '@prisma/client'
import { createInfraProvider } from '../providers/infra-provider-factory.js'
import { BootstrapService } from './bootstrap-service.js'

function currentProvider(): Provider {
  return env.INFRA_PROVIDER === 'contabo' ? 'CONTABO' : 'DIGITALOCEAN'
}

function defaultSizeSlug() {
  return env.INFRA_PROVIDER === 'contabo' ? env.CONTABO_DEFAULT_PRODUCT_ID : env.DIGITALOCEAN_DEFAULT_SIZE
}

function normalizeProvisioningRegion(region: string) {
  if (env.INFRA_PROVIDER !== 'contabo') {
    return region
  }

  const normalized = region.trim().toLowerCase()
  if (normalized === 'sgp1' || normalized === 'sin' || normalized === 'singapore') {
    return 'SIN'
  }
  return region
}

export class VmService {
  constructor(
    private readonly infra = createInfraProvider(),
    private readonly bootstrapService = new BootstrapService(),
  ) {}

  async listVmCandidates(region?: string) {
    return prisma.vm.findMany({
      where: region ? { region } : undefined,
      orderBy: { createdAt: 'asc' },
    })
  }

  async ensureVmForRegion(region: string) {
    const hostname = `clawnow-${randomUUID().slice(0, 8)}`
    const bootstrapToken = this.bootstrapService.createBootstrapToken()
    const userData = this.bootstrapService.buildCloudInit({
      bootstrapToken,
      hostname,
      region: normalizeProvisioningRegion(region),
      sizeSlug: defaultSizeSlug(),
      maxInstances: 2,
    })

    const vm = await this.infra.createVm({
      region: normalizeProvisioningRegion(region),
      sizeSlug: defaultSizeSlug(),
      maxInstances: 2,
      hostname,
      userData,
    })

    return prisma.vm.create({
      data: {
        provider: vm.provider,
        providerVmId: vm.providerVmId,
        bootstrapToken,
        name: vm.name,
        hostname: vm.hostname,
        publicIp: vm.publicIp,
        region: vm.region,
        sizeSlug: vm.sizeSlug,
        cpuTotalMillicores: vm.cpuTotalMillicores,
        memoryTotalMb: vm.memoryTotalMb,
        diskTotalGb: vm.diskTotalGb,
        maxInstances: vm.maxInstances,
        status: 'PROVISIONING',
      },
    })
  }

  async registerHeartbeat(input: {
    providerVmId?: string
    bootstrapToken?: string
    vmId?: string
    hostname: string
    publicIp?: string
    region: string
    sizeSlug: string
    cpuTotalMillicores: number
    memoryTotalMb: number
    diskTotalGb: number
    maxInstances: number
    version: string
    cpuUsedPercent?: number
    memoryUsedMb?: number
    diskUsedGb?: number
    runningContainers?: number
  }) {
    let existingVm = input.vmId
      ? await prisma.vm.findUnique({ where: { id: input.vmId } })
      : null

    if (!existingVm && input.bootstrapToken) {
      existingVm = await prisma.vm.findUnique({
        where: { bootstrapToken: input.bootstrapToken },
      })
    }

    if (!existingVm && input.providerVmId) {
      existingVm = await prisma.vm.findUnique({
        where: { providerVmId: input.providerVmId },
      })
    }

    if (existingVm) {
      return prisma.vm.update({
        where: { id: existingVm.id },
        data: {
          providerVmId: input.providerVmId ?? existingVm.providerVmId,
          bootstrapToken: input.bootstrapToken ? null : existingVm.bootstrapToken,
          hostname: input.hostname,
          name: input.hostname,
          publicIp: input.publicIp ?? existingVm.publicIp,
          region: input.region,
          sizeSlug: input.sizeSlug,
          cpuTotalMillicores: input.cpuTotalMillicores,
          memoryTotalMb: input.memoryTotalMb,
          diskTotalGb: input.diskTotalGb,
          maxInstances: input.maxInstances,
          agentVersion: input.version,
          lastHeartbeatAt: new Date(),
          cpuUsedPercent: input.cpuUsedPercent ?? 0,
          memoryUsedMb: input.memoryUsedMb ?? 0,
          diskUsedGb: input.diskUsedGb ?? 0,
          containerCount: input.runningContainers ?? 0,
          status: 'ACTIVE',
        },
      })
    }

    if (!input.providerVmId) {
      throw new Error('Agent registration requires providerVmId or a valid bootstrap token')
    }

    return prisma.vm.create({
      data: {
        provider: currentProvider(),
        providerVmId: input.providerVmId,
        hostname: input.hostname,
        name: input.hostname,
        publicIp: input.publicIp,
        region: input.region,
        sizeSlug: input.sizeSlug,
        cpuTotalMillicores: input.cpuTotalMillicores,
        memoryTotalMb: input.memoryTotalMb,
        diskTotalGb: input.diskTotalGb,
        maxInstances: input.maxInstances,
        agentVersion: input.version,
        lastHeartbeatAt: new Date(),
        cpuUsedPercent: input.cpuUsedPercent ?? 0,
        memoryUsedMb: input.memoryUsedMb ?? 0,
        diskUsedGb: input.diskUsedGb ?? 0,
        containerCount: input.runningContainers ?? 0,
        status: 'ACTIVE',
      },
    })
  }
}
