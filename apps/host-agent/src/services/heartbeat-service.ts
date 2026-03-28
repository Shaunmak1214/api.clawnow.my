import type { AgentRegistrationPayload } from '@clawnow/core'

import { env } from '../config/env.js'
import { ControlPlaneClient } from '../client/control-plane-client.js'
import { MetricsReporter } from './metrics-reporter.js'

export class HeartbeatService {
  constructor(
    private readonly client = new ControlPlaneClient(),
    private readonly metricsReporter = new MetricsReporter(),
  ) {}

  registrationPayload(): AgentRegistrationPayload {
    return {
      providerVmId: env.PROVIDER_VM_ID,
      bootstrapToken: env.BOOTSTRAP_TOKEN,
      hostname: env.HOSTNAME,
      region: env.REGION,
      sizeSlug: env.SIZE_SLUG,
      cpuTotalMillicores: 0,
      memoryTotalMb: 0,
      diskTotalGb: 0,
      maxInstances: env.MAX_INSTANCES,
      version: env.AGENT_VERSION,
    }
  }

  async register() {
    const machine = await this.metricsReporter.collectStatic()
    return this.client.register({
      ...this.registrationPayload(),
      ...machine,
    })
  }

  async sendHeartbeat(vmId: string) {
    const usage = await this.metricsReporter.collect()
    const machine = await this.metricsReporter.collectStatic()

    await this.client.heartbeat({
      vmId,
      providerVmId: env.PROVIDER_VM_ID,
      hostname: env.HOSTNAME,
      publicIp: machine.publicIp,
      region: env.REGION,
      sizeSlug: env.SIZE_SLUG,
      cpuTotalMillicores: machine.cpuTotalMillicores,
      memoryTotalMb: machine.memoryTotalMb,
      diskTotalGb: machine.diskTotalGb,
      maxInstances: env.MAX_INSTANCES,
      version: env.AGENT_VERSION,
      ...usage,
    })
  }
}
