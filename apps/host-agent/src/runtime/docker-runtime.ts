import { PATHS } from '@clawnow/core'

import { runCommand } from '../lib/shell.js'

export class DockerRuntime {
  async pullImage(imageTag: string) {
    await runCommand('docker', ['pull', imageTag])
  }

  async createContainer(input: {
    containerName: string
    imageTag: string
    hostStatePath: string
    env: Record<string, string>
  }) {
    const args = [
      'create',
      '--name',
      input.containerName,
      '--restart',
      'unless-stopped',
      '--label',
      `clawnow.container=${input.containerName}`,
      '--mount',
      `type=bind,src=${input.hostStatePath},dst=${PATHS.containerOpenClawHome}`,
    ]

    for (const [key, value] of Object.entries(input.env)) {
      args.push('--env', `${key}=${value}`)
    }

    args.push(input.imageTag)

    await runCommand('docker', args)
  }

  async startContainer(containerName: string) {
    await runCommand('docker', ['start', containerName])
  }

  async stopContainer(containerName: string) {
    await runCommand('docker', ['stop', containerName])
  }

  async restartContainer(containerName: string) {
    await runCommand('docker', ['restart', containerName])
  }

  async removeContainer(containerName: string) {
    try {
      await runCommand('docker', ['rm', '-f', containerName])
    } catch {
      return
    }
  }

  async exec(containerName: string, args: string[]) {
    return runCommand('docker', ['exec', containerName, ...args])
  }

  async logs(containerName: string, tail = 200) {
    return runCommand('docker', ['logs', '--tail', String(tail), containerName])
  }

  async inspect(containerName: string) {
    return runCommand('docker', ['inspect', containerName])
  }
}
