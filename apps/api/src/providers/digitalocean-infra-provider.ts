import { randomUUID } from 'node:crypto'

import type { Provider } from '@prisma/client'

import { PATHS } from '@clawnow/core'

import { env } from '../config/env.js'
import type { InfraProvider, ProvisionedVm, ProvisionedVolume } from './interfaces.js'

const DIGITALOCEAN_API = 'https://api.digitalocean.com/v2'

function provider(): Provider {
  return 'DIGITALOCEAN'
}

function configuredSshKeys() {
  return (env.DIGITALOCEAN_SSH_KEYS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export class DigitalOceanInfraProvider implements InfraProvider {
  async createVm(input: {
    region: string
    sizeSlug: string
    maxInstances: number
    hostname?: string
    userData?: string
  }): Promise<ProvisionedVm> {
    if (!env.DIGITALOCEAN_TOKEN) {
      const id = `dryrun-${randomUUID()}`
      return {
        provider: provider(),
        providerVmId: id,
        name: `clawnow-${id.slice(0, 8)}`,
        hostname: `clawnow-${id.slice(0, 8)}`,
        region: input.region,
        sizeSlug: input.sizeSlug,
        cpuTotalMillicores: 4000,
        memoryTotalMb: 8192,
        diskTotalGb: 160,
        maxInstances: input.maxInstances,
      }
    }

    const response = await fetch(`${DIGITALOCEAN_API}/droplets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DIGITALOCEAN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: input.hostname || `clawnow-${randomUUID().slice(0, 8)}`,
        region: input.region,
        size: input.sizeSlug,
        image: 'ubuntu-24-04-x64',
        tags: ['clawnow-host'],
        ssh_keys: configuredSshKeys(),
        user_data: input.userData,
      }),
    })

    if (!response.ok) {
      const message = await describeError(response)
      throw new Error(`Failed to create DigitalOcean VM: ${response.status}${message ? ` - ${message}` : ''}`)
    }

    const body = (await response.json()) as {
      droplet: {
        id: number
        name: string
        region: { slug: string }
        size_slug: string
        vcpus: number
        memory: number
        disk: number
      }
    }

    return {
      provider: provider(),
      providerVmId: String(body.droplet.id),
      name: body.droplet.name,
      hostname: body.droplet.name,
      region: body.droplet.region.slug,
      sizeSlug: body.droplet.size_slug,
      cpuTotalMillicores: body.droplet.vcpus * 1000,
      memoryTotalMb: body.droplet.memory,
      diskTotalGb: body.droplet.disk,
      maxInstances: input.maxInstances,
    }
  }

  async deleteVm(_providerVmId: string): Promise<void> {
    return
  }

  async createVolume(input: {
    instanceId: string
    region: string
    sizeGb: number
    mountPath: string
  }): Promise<ProvisionedVolume> {
    if (!env.DIGITALOCEAN_TOKEN) {
      return {
        provider: provider(),
        providerVolumeId: `dryrun-vol-${randomUUID()}`,
        region: input.region,
        sizeGb: input.sizeGb,
        mountPath: input.mountPath,
      }
    }

    const response = await fetch(`${DIGITALOCEAN_API}/volumes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DIGITALOCEAN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `clawnow-${input.instanceId}`,
        region: input.region,
        size_gigabytes: input.sizeGb,
        filesystem_type: 'ext4',
        description: `ClawNow instance volume mounted under ${input.mountPath || PATHS.hostInstancesRoot}`,
      }),
    })

    if (!response.ok) {
      const message = await describeError(response)
      throw new Error(`Failed to create DigitalOcean volume: ${response.status}${message ? ` - ${message}` : ''}`)
    }

    const body = (await response.json()) as {
      volume: {
        id: string
        region: { slug: string }
        size_gigabytes: number
      }
    }

    return {
      provider: provider(),
      providerVolumeId: body.volume.id,
      region: body.volume.region.slug,
      sizeGb: body.volume.size_gigabytes,
      mountPath: input.mountPath,
    }
  }

  async attachVolume(_input: { providerVmId: string; providerVolumeId: string }): Promise<void> {
    return
  }

  async detachVolume(_input: { providerVmId: string; providerVolumeId: string }): Promise<void> {
    return
  }
}

async function describeError(response: Response) {
  try {
    const body = (await response.json()) as {
      message?: string
      id?: string
      details?: unknown
    }

    const parts = [body.id, body.message]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)

    if (body.details) {
      parts.push(JSON.stringify(body.details))
    }

    return parts.join(' | ')
  } catch {
    try {
      const text = await response.text()
      return text.trim()
    } catch {
      return ''
    }
  }
}
