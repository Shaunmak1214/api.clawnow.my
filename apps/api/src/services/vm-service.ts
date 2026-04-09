import { randomUUID } from 'node:crypto'

import { env } from '../config/env.js'
import { prisma } from '../lib/prisma.js'
import type { Provider, VmStatus } from '@prisma/client'
import { createInfraProvider } from '../providers/infra-provider-factory.js'
import { BootstrapService } from './bootstrap-service.js'

function currentProvider(): Provider {
  if (env.INFRA_PROVIDER === 'railway') {
    return 'RAILWAY'
  }

  return env.INFRA_PROVIDER === 'contabo' ? 'CONTABO' : 'DIGITALOCEAN'
}

function defaultSizeSlug() {
  if (env.INFRA_PROVIDER === 'railway') {
    return env.CLAWNOW_RAILWAY_TEMPLATE_REPO
  }

  return env.INFRA_PROVIDER === 'contabo' ? env.CONTABO_DEFAULT_PRODUCT_ID : env.DIGITALOCEAN_DEFAULT_SIZE
}

function defaultMaxInstances() {
  return env.INFRA_PROVIDER === 'digitalocean' ? 2 : 1
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

export function mergeVmSyncInput<
  TCurrentVm extends {
    providerVmId: string
    name: string
    hostname: string
    publicIp: string | null
    region: string
    sizeSlug: string
    cpuTotalMillicores: number
    memoryTotalMb: number
    diskTotalGb: number
    maxInstances: number
    lastHeartbeatAt?: Date | null
    status: VmStatus
  },
  TProviderVm extends {
    providerVmId: string
    name: string
    hostname: string
    publicIp?: string
    region: string
    sizeSlug: string
    cpuTotalMillicores: number
    memoryTotalMb: number
    diskTotalGb: number
    maxInstances: number
    status?: VmStatus
  },
>(vm: TCurrentVm, providerVm: TProviderVm) {
  return {
    providerVmId: providerVm.providerVmId || vm.providerVmId,
    name: providerVm.name || vm.name,
    hostname: providerVm.hostname || vm.hostname,
    publicIp: providerVm.publicIp ?? vm.publicIp,
    region: providerVm.region || vm.region,
    sizeSlug: providerVm.sizeSlug || vm.sizeSlug,
    cpuTotalMillicores:
      providerVm.cpuTotalMillicores > 0 ? providerVm.cpuTotalMillicores : vm.cpuTotalMillicores,
    memoryTotalMb:
      providerVm.memoryTotalMb > 0 ? providerVm.memoryTotalMb : vm.memoryTotalMb,
    diskTotalGb:
      providerVm.diskTotalGb > 0 ? providerVm.diskTotalGb : vm.diskTotalGb,
    maxInstances: providerVm.maxInstances || vm.maxInstances,
    status: vm.lastHeartbeatAt ? vm.status : providerVm.status ?? vm.status,
  }
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

  async ensureVmForRegion(region: string, options?: { hostname?: string }) {
    const hostname = options?.hostname?.trim() || `clawnow-${randomUUID().slice(0, 8)}`
    const maxInstances = defaultMaxInstances()
    const bootstrapToken = env.INFRA_PROVIDER === 'railway' ? null : this.bootstrapService.createBootstrapToken()
    const cloudInitBootstrapToken = bootstrapToken ?? ''
    const userData =
      env.INFRA_PROVIDER === 'railway'
        ? undefined
        : this.bootstrapService.buildCloudInit({
            bootstrapToken: cloudInitBootstrapToken,
            hostname,
            region: normalizeProvisioningRegion(region),
            sizeSlug: defaultSizeSlug(),
            maxInstances,
          })

    const vm = await this.infra.createVm({
      region: normalizeProvisioningRegion(region),
      sizeSlug: defaultSizeSlug(),
      maxInstances,
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
        status: vm.status ?? 'PROVISIONING',
      },
    })
  }

  async syncVm(vmId: string) {
    const vm = await prisma.vm.findUnique({
      where: { id: vmId },
    })

    if (!vm) {
      return null
    }

    const providerVm = await this.infra.getVm(vm.providerVmId)
    if (!providerVm) {
      return vm
    }

    return prisma.vm.update({
      where: { id: vm.id },
      data: mergeVmSyncInput(vm, providerVm),
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
