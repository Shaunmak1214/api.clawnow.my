export const APPROVED_OPERATIONS = [
  'instance.create',
  'instance.start',
  'instance.stop',
  'instance.restart',
  'instance.remove',
  'telegram.approve',
  'pairing.claim',
  'config.write',
  'logs.collect',
  'health.check',
] as const

export type ApprovedOperation = (typeof APPROVED_OPERATIONS)[number]

export const INSTANCE_SIZE_PROFILES = {
  small: {
    key: 'small',
    reservedCpuMillicores: 750,
    reservedMemoryMb: 1536,
  },
  medium: {
    key: 'medium',
    reservedCpuMillicores: 1000,
    reservedMemoryMb: 2048,
  },
} as const

export type InstanceSizeProfile = keyof typeof INSTANCE_SIZE_PROFILES

export const VM_HEADROOM = {
  minCpuPercent: 20,
  minMemoryPercent: 25,
} as const

export const DEFAULT_VM_POLICY = {
  maxInstancesPerVm: 2,
  defaultProvider: 'DIGITALOCEAN',
  defaultRegion: 'sgp1',
} as const

export const PATHS = {
  hostInstancesRoot: '/mnt/clawnow/instances',
  containerOpenClawHome: '/var/lib/openclaw',
  containerStateDir: '/var/lib/openclaw/state',
  containerConfigPath: '/var/lib/openclaw/state/openclaw.json',
} as const

export interface AgentRegistrationPayload {
  providerVmId?: string
  bootstrapToken?: string
  hostname: string
  publicIp?: string
  region: string
  sizeSlug: string
  cpuTotalMillicores: number
  memoryTotalMb: number
  diskTotalGb: number
  maxInstances: number
  version: string
}

export interface AgentRegistrationResponse {
  vmId: string
  pollingIntervalMs: number
}

export interface AgentHeartbeatPayload {
  vmId: string
  providerVmId?: string
  publicIp?: string
  version: string
  cpuUsedPercent: number
  memoryUsedMb: number
  diskUsedGb: number
  runningContainers: number
}

export interface VmCandidate {
  id: string
  region: string
  status: string
  maxInstances: number
  containerCount: number
  cpuTotalMillicores: number
  reservedCpuMillicores: number
  memoryTotalMb: number
  reservedMemoryMb: number
}

export interface PlacementDecision {
  action: 'use-existing' | 'create-vm'
  vmId?: string
  reason: string
}

export interface InstanceCreatePayload {
  instanceId: string
  containerName: string
  imageTag: string
  sizeProfile: InstanceSizeProfile
  hostStatePath: string
  sshUsername: string
  env: Record<string, string>
}

export interface InstanceLifecyclePayload {
  instanceId: string
  containerName: string
  sshUsername?: string
}

export interface TelegramApprovePayload {
  instanceId: string
  containerName: string
  botTokenSecretRef: string
}

export interface PairingClaimPayload {
  instanceId: string
  containerName: string
  pairingCode: string
}

export interface ConfigWritePayload {
  instanceId: string
  hostStatePath: string
  files: Array<{
    relativePath: string
    content: string
  }>
}

export interface LogsCollectPayload {
  instanceId: string
  containerName: string
  tail?: number
}

export interface HealthCheckPayload {
  instanceId: string
  containerName: string
}

export interface InstanceAccessCredentials {
  sshUsername: string
  sshPassword: string
}

export type OperationPayloadMap = {
  'instance.create': InstanceCreatePayload
  'instance.start': InstanceLifecyclePayload
  'instance.stop': InstanceLifecyclePayload
  'instance.restart': InstanceLifecyclePayload
  'instance.remove': InstanceLifecyclePayload
  'telegram.approve': TelegramApprovePayload
  'pairing.claim': PairingClaimPayload
  'config.write': ConfigWritePayload
  'logs.collect': LogsCollectPayload
  'health.check': HealthCheckPayload
}

export interface ClaimedOperationJob<T extends ApprovedOperation = ApprovedOperation> {
  id: string
  type: T
  vmId: string
  instanceId: string | null
  payload: OperationPayloadMap[T]
}

export function isApprovedOperation(value: string): value is ApprovedOperation {
  return APPROVED_OPERATIONS.includes(value as ApprovedOperation)
}

export function containerNameForInstance(instanceId: string): string {
  return `openclaw-${instanceId}`
}

export function hostStatePathForInstance(instanceId: string): string {
  return `${PATHS.hostInstancesRoot}/${instanceId}`
}
