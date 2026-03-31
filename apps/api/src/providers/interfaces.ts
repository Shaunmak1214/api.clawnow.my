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
  status?: 'PROVISIONING' | 'ACTIVE' | 'OFFLINE' | 'FAILED'
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
  getVm(providerVmId: string): Promise<ProvisionedVm | null>
  deleteVm(providerVmId: string): Promise<void>
  createVolume(input: {
    instanceId: string
    providerVmId?: string
    region: string
    sizeGb: number
    mountPath: string
  }): Promise<ProvisionedVolume>
  attachVolume(input: { providerVmId: string; providerVolumeId: string }): Promise<void>
  detachVolume(input: { providerVmId: string; providerVolumeId: string }): Promise<void>
  configureInstanceRuntime?(input: {
    providerVmId: string
    instanceId: string
    name: string
    region: string
    imageTag: string
    setupPassword: string
    mountPath: string
  }): Promise<{
    providerVmId?: string
    publicUrl?: string
    status?: ProvisionedVm['status']
  }>
}

export interface BackupProvider {
  exportInstance(input: { instanceId: string; sourcePath: string }): Promise<{ storageKey: string; checksum: string }>
  uploadBackup(input: { storageKey: string; localPath: string }): Promise<void>
  restoreBackup(input: { storageKey: string; destinationPath: string }): Promise<void>
  verifyRestore(input: { destinationPath: string; checksum: string }): Promise<boolean>
}
