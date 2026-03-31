import { randomUUID } from 'node:crypto'

import type { Provider } from '@prisma/client'

import { PATHS } from '@clawnow/core'

import { env } from '../config/env.js'
import type { InfraProvider, ProvisionedVm, ProvisionedVolume } from './interfaces.js'

const CONTABO_AUTH_URL = 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token'
const CONTABO_API_URL = 'https://api.contabo.com/v1'

function provider(): Provider {
  return 'CONTABO'
}

function configuredSshSecretIds() {
  return (env.CONTABO_SSH_KEY_SECRET_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
}

function mapRegion(region: string) {
  const normalized = region.trim().toLowerCase()

  switch (normalized) {
    case 'sgp1':
    case 'sin':
    case 'singapore':
      return 'SIN'
    case 'eu':
    case 'eu1':
      return 'EU'
    case 'uk':
      return 'UK'
    case 'us-central':
    case 'usc1':
      return 'US-central'
    case 'us-east':
    case 'use1':
      return 'US-east'
    case 'us-west':
    case 'usw1':
      return 'US-west'
    case 'aus':
      return 'AUS'
    case 'jpn':
      return 'JPN'
    case 'ind':
      return 'IND'
    default:
      return region
  }
}

interface AccessToken {
  token: string
  expiresAt: number
}

interface ContaboInstanceRecord {
  instanceId: number
  name?: string
  displayName?: string
  region?: string
  productId?: string
  status?: string
  ipConfig?: {
    v4?: {
      ip?: string
    }
  }
  cpuCores?: number
  ramMb?: string | number
  diskMb?: string | number
}

function toInt(value: string | number | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

function toDiskGb(diskMb: string | number | undefined) {
  const mb = toInt(diskMb)
  return mb > 0 ? Math.ceil(mb / 1024) : 0
}

function mapVmStatus(status?: string): ProvisionedVm['status'] {
  switch ((status || '').trim().toLowerCase()) {
    case 'running':
    case 'stopped':
      return 'ACTIVE'
    case 'error':
    case 'product_not_available':
    case 'verification_required':
    case 'pending_payment':
    case 'other':
      return 'FAILED'
    case 'uninstalled':
    case 'rescue':
      return 'OFFLINE'
    case 'provisioning':
    case 'installing':
    case 'manual_provisioning':
    case 'reset_password':
    case 'unknown':
    default:
      return 'PROVISIONING'
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ContaboInfraProvider implements InfraProvider {
  private accessToken: AccessToken | null = null

  async createVm(input: {
    region: string
    sizeSlug: string
    maxInstances: number
    hostname?: string
    userData?: string
  }): Promise<ProvisionedVm> {
    if (!env.CONTABO_CLIENT_ID || !env.CONTABO_CLIENT_SECRET || !env.CONTABO_API_USER || !env.CONTABO_API_PASSWORD) {
      const id = `dryrun-${randomUUID()}`
      return {
        provider: provider(),
        providerVmId: id,
        name: `clawnow-${id.slice(0, 8)}`,
        hostname: input.hostname || `clawnow-${id.slice(0, 8)}`,
        region: mapRegion(input.region),
        sizeSlug: input.sizeSlug,
        cpuTotalMillicores: 6000,
        memoryTotalMb: 12288,
        diskTotalGb: 150,
        maxInstances: input.maxInstances,
        publicIp: '203.0.113.10',
        status: 'ACTIVE',
      }
    }

    const token = await this.getAccessToken()
    const requestId = randomUUID()
    const payload: Record<string, unknown> = {
      productId: input.sizeSlug,
      region: mapRegion(input.region),
      period: env.CONTABO_CONTRACT_PERIOD_MONTHS,
      displayName: input.hostname || `clawnow-${randomUUID().slice(0, 8)}`,
      defaultUser: 'root',
      userData: input.userData,
    }

    if (env.CONTABO_DEFAULT_IMAGE_ID) {
      payload.imageId = env.CONTABO_DEFAULT_IMAGE_ID
    }

    const sshKeys = configuredSshSecretIds()
    if (sshKeys.length > 0) {
      payload.sshKeys = sshKeys
    }

    if (env.CONTABO_ROOT_PASSWORD_SECRET_ID) {
      payload.rootPassword = Number(env.CONTABO_ROOT_PASSWORD_SECRET_ID)
    }

    const response = await fetch(`${CONTABO_API_URL}/compute/instances`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const message = await describeError(response)
      throw new Error(`Failed to create Contabo VM: ${response.status}${message ? ` - ${message}` : ''}`)
    }

    const body = (await response.json()) as {
      data?: Array<{
        instanceId: number
        createdDate?: string
        productId?: string
        region?: string
        status?: string
      }>
    }

    const created = body.data?.[0]
    if (!created?.instanceId) {
      throw new Error('Failed to create Contabo VM: response did not include an instance id')
    }

    const providerVmId = String(created.instanceId)
    const fallbackHostname = input.hostname || `clawnow-${providerVmId.slice(0, 8)}`
    const syncedVm = await this.waitForVm(providerVmId, {
      region: mapRegion(input.region),
      sizeSlug: input.sizeSlug,
      hostname: fallbackHostname,
      maxInstances: input.maxInstances,
    })

    return (
      syncedVm || {
        provider: provider(),
        providerVmId,
        name: created.instanceId.toString(),
        hostname: fallbackHostname,
        region: mapRegion(input.region),
        sizeSlug: input.sizeSlug,
        cpuTotalMillicores: 0,
        memoryTotalMb: 0,
        diskTotalGb: 0,
        maxInstances: input.maxInstances,
        status: mapVmStatus(created.status),
      }
    )
  }

  async getVm(providerVmId: string): Promise<ProvisionedVm | null> {
    if (!env.CONTABO_CLIENT_ID || !env.CONTABO_CLIENT_SECRET || !env.CONTABO_API_USER || !env.CONTABO_API_PASSWORD) {
      return null
    }

    const token = await this.getAccessToken()
    const response = await fetch(`${CONTABO_API_URL}/compute/instances/${providerVmId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-request-id': randomUUID(),
      },
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      const message = await describeError(response)
      throw new Error(`Failed to fetch Contabo VM ${providerVmId}: ${response.status}${message ? ` - ${message}` : ''}`)
    }

    const body = (await response.json()) as {
      data?: ContaboInstanceRecord[]
    }

    const instance = body.data?.[0]
    if (!instance?.instanceId) {
      return null
    }

    return this.mapInstance(instance)
  }

  async deleteVm(providerVmId: string): Promise<void> {
    if (!env.CONTABO_CLIENT_ID || !env.CONTABO_CLIENT_SECRET || !env.CONTABO_API_USER || !env.CONTABO_API_PASSWORD) {
      return
    }

    const token = await this.getAccessToken()
    const response = await fetch(`${CONTABO_API_URL}/compute/instances/${providerVmId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-request-id': randomUUID(),
      },
      body: JSON.stringify({
        cancelDate: new Date().toISOString(),
      }),
    })

    if (!response.ok) {
      const message = await describeError(response)
      throw new Error(`Failed to cancel Contabo VM: ${response.status}${message ? ` - ${message}` : ''}`)
    }
  }

  async createVolume(input: {
    instanceId: string
    providerVmId?: string
    region: string
    sizeGb: number
    mountPath: string
  }): Promise<ProvisionedVolume> {
    return {
      provider: provider(),
      providerVolumeId: `local-disk-${input.instanceId}`,
      region: mapRegion(input.region),
      sizeGb: input.sizeGb,
      mountPath: input.mountPath || `${PATHS.hostInstancesRoot}/${input.instanceId}`,
    }
  }

  async attachVolume(_input: { providerVmId: string; providerVolumeId: string }): Promise<void> {
    return
  }

  async detachVolume(_input: { providerVmId: string; providerVolumeId: string }): Promise<void> {
    return
  }

  private async getAccessToken() {
    const now = Date.now()
    if (this.accessToken && this.accessToken.expiresAt > now + 30_000) {
      return this.accessToken.token
    }

    const body = new URLSearchParams({
      client_id: env.CONTABO_CLIENT_ID || '',
      client_secret: env.CONTABO_CLIENT_SECRET || '',
      username: env.CONTABO_API_USER || '',
      password: env.CONTABO_API_PASSWORD || '',
      grant_type: 'password',
    })

    const response = await fetch(CONTABO_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    if (!response.ok) {
      const message = await describeError(response)
      throw new Error(`Failed to authenticate with Contabo: ${response.status}${message ? ` - ${message}` : ''}`)
    }

    const payload = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }

    if (!payload.access_token) {
      throw new Error('Failed to authenticate with Contabo: access token missing in response')
    }

    this.accessToken = {
      token: payload.access_token,
      expiresAt: now + (payload.expires_in ?? 300) * 1000,
    }

    return this.accessToken.token
  }

  private mapInstance(instance: ContaboInstanceRecord): ProvisionedVm {
    const hostname = instance.name || `clawnow-${String(instance.instanceId).slice(0, 8)}`

    return {
      provider: provider(),
      providerVmId: String(instance.instanceId),
      name: instance.displayName || hostname,
      hostname,
      publicIp: instance.ipConfig?.v4?.ip,
      region: instance.region || env.CONTABO_DEFAULT_REGION,
      sizeSlug: instance.productId || env.CONTABO_DEFAULT_PRODUCT_ID,
      cpuTotalMillicores: toInt(instance.cpuCores) * 1000,
      memoryTotalMb: toInt(instance.ramMb),
      diskTotalGb: toDiskGb(instance.diskMb),
      maxInstances: 1,
      status: mapVmStatus(instance.status),
    }
  }

  private async waitForVm(
    providerVmId: string,
    fallback: {
      region: string
      sizeSlug: string
      hostname: string
      maxInstances: number
    },
  ) {
    let latestVm: ProvisionedVm | null = null

    for (let attempt = 0; attempt < 15; attempt += 1) {
      latestVm = await this.getVm(providerVmId)

      if (
        latestVm &&
        latestVm.publicIp &&
        latestVm.cpuTotalMillicores > 0 &&
        latestVm.memoryTotalMb > 0 &&
        latestVm.diskTotalGb > 0 &&
        latestVm.status !== 'PROVISIONING'
      ) {
        return latestVm
      }

      await sleep(4000)
    }

    if (latestVm) {
      return latestVm
    }

    return {
      provider: provider(),
      providerVmId,
      name: fallback.hostname,
      hostname: fallback.hostname,
      region: fallback.region,
      sizeSlug: fallback.sizeSlug,
      cpuTotalMillicores: 0,
      memoryTotalMb: 0,
      diskTotalGb: 0,
      maxInstances: fallback.maxInstances,
      status: 'PROVISIONING' as const,
    }
  }
}

async function describeError(response: Response) {
  try {
    const body = (await response.json()) as {
      message?: string
      error?: string
      error_description?: string
      data?: unknown
    }

    return [body.error, body.error_description, body.message, body.data ? JSON.stringify(body.data) : '']
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .join(' | ')
  } catch {
    try {
      return (await response.text()).trim()
    } catch {
      return ''
    }
  }
}
