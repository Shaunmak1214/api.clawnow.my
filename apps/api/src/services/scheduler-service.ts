import { DEFAULT_VM_POLICY, INSTANCE_SIZE_PROFILES, VM_HEADROOM, type InstanceSizeProfile, type PlacementDecision, type VmCandidate } from '@clawnow/core'

function hasCapacity(vm: VmCandidate, sizeProfile: InstanceSizeProfile): boolean {
  const profile = INSTANCE_SIZE_PROFILES[sizeProfile]
  if (vm.containerCount >= vm.maxInstances) return false

  const nextReservedCpu = vm.reservedCpuMillicores + profile.reservedCpuMillicores
  const nextReservedMemory = vm.reservedMemoryMb + profile.reservedMemoryMb

  const cpuHeadroomPercent = ((vm.cpuTotalMillicores - nextReservedCpu) / vm.cpuTotalMillicores) * 100
  const memoryHeadroomPercent = ((vm.memoryTotalMb - nextReservedMemory) / vm.memoryTotalMb) * 100

  return cpuHeadroomPercent >= VM_HEADROOM.minCpuPercent && memoryHeadroomPercent >= VM_HEADROOM.minMemoryPercent
}

export class SchedulerService {
  decidePlacement(vms: VmCandidate[], input: { region: string; sizeProfile: InstanceSizeProfile }): PlacementDecision {
    const candidates = vms
      .filter((vm) => vm.region === input.region)
      .filter((vm) => vm.status === 'ACTIVE')
      .filter((vm) => hasCapacity(vm, input.sizeProfile))
      .sort((left, right) => {
        if (left.containerCount !== right.containerCount) {
          return left.containerCount - right.containerCount
        }
        return left.reservedMemoryMb - right.reservedMemoryMb
      })

    if (candidates.length > 0) {
      return {
        action: 'use-existing',
        vmId: candidates[0]!.id,
        reason: 'Found active VM with enough reserved CPU, memory, and safety headroom.',
      }
    }

    return {
      action: 'create-vm',
      reason: `No active VM matched the safe placement rules. Provision a new ${DEFAULT_VM_POLICY.defaultRegion} host.`,
    }
  }
}
