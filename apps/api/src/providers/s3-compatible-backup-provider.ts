import { createHash } from 'node:crypto'

import type { BackupProvider } from './interfaces.js'

export class S3CompatibleBackupProvider implements BackupProvider {
  async exportInstance(input: { instanceId: string; sourcePath: string }) {
    const checksum = createHash('sha256').update(`${input.instanceId}:${input.sourcePath}`).digest('hex')
    return {
      storageKey: `instances/${input.instanceId}/${Date.now()}.tar.gz`,
      checksum,
    }
  }

  async uploadBackup(_input: { storageKey: string; localPath: string }): Promise<void> {
    return
  }

  async restoreBackup(_input: { storageKey: string; destinationPath: string }): Promise<void> {
    return
  }

  async verifyRestore(_input: { destinationPath: string; checksum: string }): Promise<boolean> {
    return true
  }
}
