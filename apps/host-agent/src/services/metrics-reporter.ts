import os from 'node:os'

import { runCommand } from '../lib/shell.js'

export class MetricsReporter {
  async collectStatic() {
    const cpuTotalMillicores = (os.cpus().length || 1) * 1000
    const memoryTotalMb = Math.round(os.totalmem() / 1024 / 1024)

    let diskTotalGb = 0
    try {
      const result = await runCommand('df', ['-k', '/'])
      const lines = result.stdout.trim().split('\n')
      const columns = lines[1]?.trim().split(/\s+/)
      const totalKb = columns?.[1] ? Number(columns[1]) : 0
      diskTotalGb = Math.round(totalKb / 1024 / 1024)
    } catch {
      diskTotalGb = 0
    }

    return {
      cpuTotalMillicores,
      memoryTotalMb,
      diskTotalGb,
      publicIp: await this.resolvePublicIp(),
    }
  }

  async collect() {
    const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024)
    const freeMemoryMb = Math.round(os.freemem() / 1024 / 1024)
    const memoryUsedMb = totalMemoryMb - freeMemoryMb
    const load = os.loadavg()[0] ?? 0
    const cpuCount = os.cpus().length || 1
    const cpuUsedPercent = Math.min(100, Math.round((load / cpuCount) * 100))

    let runningContainers = 0
    try {
      const result = await runCommand('docker', ['ps', '-q'])
      runningContainers = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean).length
    } catch {
      runningContainers = 0
    }

    let diskUsedGb = 0
    try {
      const result = await runCommand('df', ['-k', '/'])
      const lines = result.stdout.trim().split('\n')
      const columns = lines[1]?.trim().split(/\s+/)
      const usedKb = columns?.[2] ? Number(columns[2]) : 0
      diskUsedGb = Math.round(usedKb / 1024 / 1024)
    } catch {
      diskUsedGb = 0
    }

    return {
      cpuUsedPercent,
      memoryUsedMb,
      diskUsedGb,
      runningContainers,
    }
  }

  private async resolvePublicIp() {
    try {
      const response = await fetch('http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address')
      if (response.ok) {
        const value = (await response.text()).trim()
        if (value) {
          return value
        }
      }
    } catch {
      // Ignore metadata failures and fall through to local inspection.
    }

    try {
      const result = await runCommand('sh', ['-lc', "hostname -I | awk '{print $1}'"])
      const value = result.stdout.trim()
      return value || undefined
    } catch {
      return undefined
    }
  }
}
