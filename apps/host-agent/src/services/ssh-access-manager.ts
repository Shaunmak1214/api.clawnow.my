import { mkdir, rm, writeFile } from 'node:fs/promises'

import { ControlPlaneClient } from '../client/control-plane-client.js'
import { runCommand } from '../lib/shell.js'

const ACCESS_GROUP = 'clawnow-instance-users'
const LOGIN_SHELL = '/usr/local/bin/clawnow-instance-login'
const MAPPING_ROOT = '/etc/clawnow-instance-users'
const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config.d/50-clawnow-instance-access.conf'
const SSHD_CONFIG = `PasswordAuthentication yes
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM yes
PermitRootLogin no
AllowGroups clawnow-instance-users
`

export class SshAccessManager {
  constructor(private readonly client = new ControlPlaneClient()) {}

  async configureInstanceAccess(input: { instanceId: string; vmId: string; sshUsername: string; containerName: string }) {
    const credentials = await this.client.getInstanceAccessCredentials(input.instanceId, input.vmId)

    await this.ensureAccessGroup()
    await this.ensureUser(credentials.sshUsername)
    await this.setPassword(credentials.sshUsername, credentials.sshPassword)
    await this.writeMapping(credentials.sshUsername, input.containerName, input.instanceId)
    await this.ensureSshConfiguration()
  }

  async removeInstanceAccess(sshUsername?: string) {
    if (!sshUsername) {
      return
    }

    await rm(`${MAPPING_ROOT}/${sshUsername}.env`, { force: true })

    try {
      await runCommand('userdel', ['-r', sshUsername])
    } catch {
      return
    }
  }

  private async ensureAccessGroup() {
    try {
      await runCommand('getent', ['group', ACCESS_GROUP])
    } catch {
      await runCommand('groupadd', ['--system', ACCESS_GROUP])
    }
  }

  private async ensureUser(sshUsername: string) {
    const commonArgs = ['-s', LOGIN_SHELL, '-a', '-G', ACCESS_GROUP, sshUsername]

    try {
      await runCommand('id', ['-u', sshUsername])
      await runCommand('usermod', commonArgs)
    } catch {
      await runCommand('useradd', ['-m', '-s', LOGIN_SHELL, '-G', ACCESS_GROUP, sshUsername])
    }
  }

  private async setPassword(sshUsername: string, sshPassword: string) {
    await runCommand('chpasswd', [], {
      input: `${sshUsername}:${sshPassword}\n`,
    })
  }

  private async writeMapping(sshUsername: string, containerName: string, instanceId: string) {
    await mkdir(MAPPING_ROOT, { recursive: true })
    await writeFile(
      `${MAPPING_ROOT}/${sshUsername}.env`,
      `CONTAINER_NAME=${containerName}\nINSTANCE_ID=${instanceId}\n`,
      { mode: 0o600 },
    )
  }

  private async ensureSshConfiguration() {
    await writeFile(SSHD_CONFIG_PATH, SSHD_CONFIG, { mode: 0o644 })
    await runCommand('sshd', ['-t'])
    await runCommand('systemctl', ['reload', 'ssh'])
  }
}
