import type {
  AgentHeartbeatPayload,
  AgentRegistrationPayload,
  AgentRegistrationResponse,
  ClaimedOperationJob,
  InstanceAccessCredentials,
} from '@clawnow/core'

import { env } from '../config/env.js'

export class ControlPlaneClient {
  private headers() {
    return {
      'Content-Type': 'application/json',
      'x-agent-secret': env.AGENT_SHARED_SECRET,
    }
  }

  async register(payload: AgentRegistrationPayload): Promise<AgentRegistrationResponse> {
    const response = await fetch(`${env.API_BASE_URL}/agent/register`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`Agent registration failed: ${response.status}${await describeError(response)}`)
    }

    return response.json() as Promise<AgentRegistrationResponse>
  }

  async heartbeat(payload: AgentHeartbeatPayload & { providerVmId?: string; hostname: string; publicIp?: string; region: string; sizeSlug: string; cpuTotalMillicores: number; memoryTotalMb: number; diskTotalGb: number; maxInstances: number }) {
    const response = await fetch(`${env.API_BASE_URL}/agent/heartbeat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`Agent heartbeat failed: ${response.status}${await describeError(response)}`)
    }
  }

  async claimJobs(vmId: string, limit = 5): Promise<ClaimedOperationJob[]> {
    const response = await fetch(`${env.API_BASE_URL}/agent/jobs/claim`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ vmId, limit }),
    })

    if (!response.ok) {
      throw new Error(`Failed to claim jobs: ${response.status}${await describeError(response)}`)
    }

    const body = (await response.json()) as { jobs: ClaimedOperationJob[] }
    return body.jobs
  }

  async getInstanceAccessCredentials(instanceId: string, vmId: string): Promise<InstanceAccessCredentials> {
    const response = await fetch(`${env.API_BASE_URL}/agent/instances/${instanceId}/access?vmId=${encodeURIComponent(vmId)}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch SSH credentials for ${instanceId}: ${response.status}${await describeError(response)}`)
    }

    return response.json() as Promise<InstanceAccessCredentials>
  }

  async sendLogs(jobId: string, logs: Array<{ level: string; message: string }>) {
    if (logs.length === 0) return

    const response = await fetch(`${env.API_BASE_URL}/agent/jobs/${jobId}/logs`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ logs }),
    })

    if (!response.ok) {
      throw new Error(`Failed to send logs for ${jobId}: ${response.status}${await describeError(response)}`)
    }
  }

  async completeJob(jobId: string, result?: Record<string, unknown>) {
    const response = await fetch(`${env.API_BASE_URL}/agent/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ result }),
    })

    if (!response.ok) {
      throw new Error(`Failed to complete job ${jobId}: ${response.status}${await describeError(response)}`)
    }
  }

  async failJob(jobId: string, errorMessage: string) {
    const response = await fetch(`${env.API_BASE_URL}/agent/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ errorMessage }),
    })

    if (!response.ok) {
      throw new Error(`Failed to fail job ${jobId}: ${response.status}${await describeError(response)}`)
    }
  }
}

async function describeError(response: Response) {
  try {
    const text = await response.text()
    return text ? ` - ${text}` : ''
  } catch {
    return ''
  }
}
