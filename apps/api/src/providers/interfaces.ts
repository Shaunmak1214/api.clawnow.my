import type { Provider } from '@prisma/client'

export interface ProvisionedVm {
  provider: Provider
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
}

export interface ProvisionedVolume {
  provider: Provider
  providerVolumeId: string
  region: string
  sizeGb: number
  mountPath: string
}

export interface InfraProvider {
  createVm(input: {
    region: string
    sizeSlug: string
    maxInstances: number
    hostname?: string
    userData?: string
  }): Promise<ProvisionedVm>
  deleteVm(providerVmId: string): Promise<void>
  createVolume(input: {
    instanceId: string
    region: string
    sizeGb: number
    mountPath: string
  }): Promise<ProvisionedVolume>
  attachVolume(input: { providerVmId: string; providerVolumeId: string }): Promise<void>
  detachVolume(input: { providerVmId: string; providerVolumeId: string }): Promise<void>
}

export interface BackupProvider {
  exportInstance(input: { instanceId: string; sourcePath: string }): Promise<{ storageKey: string; checksum: string }>
  uploadBackup(input: { storageKey: string; localPath: string }): Promise<void>
  restoreBackup(input: { storageKey: string; destinationPath: string }): Promise<void>
  verifyRestore(input: { destinationPath: string; checksum: string }): Promise<boolean>
}
