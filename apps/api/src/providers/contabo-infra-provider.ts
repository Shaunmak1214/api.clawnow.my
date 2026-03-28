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

    return {
      provider: provider(),
      providerVmId: String(created.instanceId),
      name: String(created.instanceId),
      hostname: input.hostname || `clawnow-${String(created.instanceId).slice(0, 8)}`,
      region: mapRegion(input.region),
      sizeSlug: input.sizeSlug,
      cpuTotalMillicores: 0,
      memoryTotalMb: 0,
      diskTotalGb: 0,
      maxInstances: input.maxInstances,
    }
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
    region: string
    sizeGb: number
    mountPath: string
  }): Promise<ProvisionedVolume> {
    return {
      provider: provider(),
      providerVolumeId: `logical-${input.instanceId}`,
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
