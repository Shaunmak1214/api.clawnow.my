import { randomUUID } from 'node:crypto'

import type { Provider } from '@prisma/client'

import { env } from '../config/env.js'
import type { InfraProvider, ProvisionedVm, ProvisionedVolume } from './interfaces.js'

type GraphQLRecord = Record<string, unknown>

export type RailwayProjectWebhook = {
  id: string
  projectId?: string
  url: string
  lastStatus?: string
}

const RAILWAY_PROVIDER_PREFIX = 'railway'

function logRailway(stage: string, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : ''
  console.info(`[railway] ${stage}${payload}`)
}

function logRailwayError(stage: string, error: unknown, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : ''
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[railway] ${stage} failed: ${message}${payload}`)
}

function logRailwayWarn(stage: string, details?: Record<string, unknown>) {
  const payload = details ? ` ${JSON.stringify(details)}` : ''
  console.warn(`[railway] ${stage}${payload}`)
}

function provider(): Provider {
  return 'RAILWAY'
}

function makeProviderVmId(input: {
  projectId: string
  environmentId: string
  serviceId: string
  deploymentId?: string
}) {
  return [
    RAILWAY_PROVIDER_PREFIX,
    input.projectId,
    input.environmentId,
    input.serviceId,
    input.deploymentId,
  ]
    .filter(Boolean)
    .join(':')
}

export function parseRailwayProviderVmId(providerVmId: string) {
  const [prefix, projectId, environmentId, serviceId, deploymentId] = providerVmId.split(':')
  if (prefix !== RAILWAY_PROVIDER_PREFIX || !projectId || !environmentId || !serviceId) {
    throw new Error(`Invalid Railway providerVmId: ${providerVmId}`)
  }

  return {
    projectId,
    environmentId,
    serviceId,
    deploymentId,
  }
}

function sanitizeName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || `clawnow-${randomUUID().slice(0, 8)}`
}

export function mapRailwayDeploymentStatus(status?: string): ProvisionedVm['status'] {
  switch ((status || '').trim().toUpperCase()) {
    case 'ACTIVE':
    case 'SUCCESS':
      return 'ACTIVE'
    case 'COMPLETED':
    case 'SKIPPED':
      return 'ACTIVE'
    case 'FAILED':
    case 'CRASHED':
    case 'CANCELED':
      return 'FAILED'
    case 'REMOVED':
    case 'REMOVING':
      return 'OFFLINE'
    case 'QUEUED':
    case 'WAITING':
    case 'BUILDING':
    case 'DEPLOYING':
    case 'INITIALIZING':
    case 'SLEEPING':
    default:
      return 'PROVISIONING'
  }
}

export function buildRailwayVmSnapshot(input: {
  projectId: string
  environmentId: string
  serviceId: string
  deploymentId?: string
  latestDeploymentId?: string
  deploymentStatus?: string
  latestDeploymentStatus?: string
  publicUrl?: string
  serviceName?: string
}): ProvisionedVm {
  const resolvedDeploymentId = input.latestDeploymentId || input.deploymentId
  const resolvedDeploymentStatus = input.latestDeploymentStatus || input.deploymentStatus

  return {
    provider: provider(),
    providerVmId: makeProviderVmId({
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      deploymentId: resolvedDeploymentId,
    }),
    name: input.serviceName || input.serviceId,
    hostname: input.serviceName || input.serviceId,
    region: 'railway',
    sizeSlug: env.CLAWNOW_RAILWAY_TEMPLATE_REPO,
    cpuTotalMillicores: 0,
    memoryTotalMb: 0,
    diskTotalGb: 5,
    maxInstances: 1,
    status: mapRailwayDeploymentStatus(resolvedDeploymentStatus),
    publicIp: input.publicUrl,
  }
}

function asObject(value: unknown): GraphQLRecord | null {
  return typeof value === 'object' && value !== null ? (value as GraphQLRecord) : null
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function asBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

function pickId(value: unknown): string | undefined {
  const object = asObject(value)
  if (!object) {
    return undefined
  }
  return asString(object.id)
}

function collectConnectionNodes(value: unknown): GraphQLRecord[] {
  if (Array.isArray(value)) {
    return value.map((item) => asObject(item)).filter(Boolean) as GraphQLRecord[]
  }

  const object = asObject(value)
  if (!object) {
    return []
  }

  const edges = Array.isArray(object.edges) ? object.edges : []
  if (edges.length > 0) {
    return edges.map((edge) => asObject(asObject(edge)?.node)).filter(Boolean) as GraphQLRecord[]
  }

  const nodes = Array.isArray(object.nodes) ? object.nodes : []
  if (nodes.length > 0) {
    return nodes.map((node) => asObject(node)).filter(Boolean) as GraphQLRecord[]
  }

  return []
}

function collectEnvironmentNodes(value: unknown): Array<{ id: string; name?: string; isEphemeral?: boolean }> {
  const object = asObject(value)
  if (!object) {
    return []
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const node = asObject(item)
        const id = node ? asString(node.id) : undefined
        return id
          ? {
              id,
              name: node ? asString(node.name) : undefined,
              isEphemeral: node ? asBoolean(node.isEphemeral) : undefined,
            }
          : null
      })
      .filter(Boolean) as Array<{ id: string; name?: string; isEphemeral?: boolean }>
  }

  const edges = Array.isArray(object.edges) ? object.edges : []
  if (edges.length > 0) {
    return edges
      .map((edge) => {
        const node = asObject(asObject(edge)?.node)
        const id = node ? asString(node.id) : undefined
        return id
          ? {
              id,
              name: node ? asString(node.name) : undefined,
              isEphemeral: node ? asBoolean(node.isEphemeral) : undefined,
            }
          : null
      })
      .filter(Boolean) as Array<{ id: string; name?: string; isEphemeral?: boolean }>
  }

  return []
}

function pickDomain(value: unknown): string | undefined {
  if (typeof value === 'string' && value.includes('.')) {
    return value
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const domain = pickDomain(item)
      if (domain) {
        return domain
      }
    }
    return undefined
  }

  const object = asObject(value)
  if (!object) {
    return undefined
  }

  for (const key of ['domain', 'hostname', 'fqdn', 'name']) {
    const candidate = asString(object[key])
    if (candidate && candidate.includes('.')) {
      return candidate
    }
  }

  for (const nested of Object.values(object)) {
    const domain = pickDomain(nested)
    if (domain) {
      return domain
    }
  }

  return undefined
}

function normalizeWebhookUrl(url: string) {
  return url.replace(/\/+$/, '')
}

function parseRailwayWebhook(value: unknown): RailwayProjectWebhook | null {
  const object = asObject(value)
  if (!object) {
    return null
  }

  const id = asString(object.id)
  const url = asString(object.url)

  if (!id || !url) {
    return null
  }

  return {
    id,
    url: normalizeWebhookUrl(url),
    projectId: asString(object.projectId),
    lastStatus: asString(object.lastStatus),
  }
}

function pickDeploymentSnapshot(value: unknown): { id?: string; status?: string } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const snapshot = pickDeploymentSnapshot(item)
      if (snapshot) {
        return snapshot
      }
    }

    return null
  }

  const object = asObject(value)
  if (!object) {
    return null
  }

  const id = asString(object.id)
  const status = asString(object.status)
  if (id || status) {
    return {
      ...(id ? { id } : {}),
      ...(status ? { status } : {}),
    }
  }

  const edges = Array.isArray(object.edges) ? object.edges : []
  for (const edge of edges) {
    const snapshot = pickDeploymentSnapshot(asObject(edge)?.node)
    if (snapshot) {
      return snapshot
    }
  }

  const nodes = Array.isArray(object.nodes) ? object.nodes : []
  for (const node of nodes) {
    const snapshot = pickDeploymentSnapshot(node)
    if (snapshot) {
      return snapshot
    }
  }

  for (const nested of Object.values(object)) {
    const snapshot = pickDeploymentSnapshot(nested)
    if (snapshot) {
      return snapshot
    }
  }

  return null
}

function formatGraphqlErrorMessage(
  operationName: string,
  rawMessage: string,
  variables?: Record<string, unknown>,
) {
  if (!/not authorized/i.test(rawMessage)) {
    return rawMessage
  }

  if (env.CLAWNOW_RAILWAY_TOKEN_TYPE !== 'project') {
    return rawMessage
  }

  const targetProjectId =
    asString(variables?.projectId) ||
    env.CLAWNOW_RAILWAY_PROJECT_ID ||
    'unknown-project'
  const targetEnvironmentId =
    asString(variables?.environmentId) ||
    env.CLAWNOW_RAILWAY_ENVIRONMENT_ID ||
    'unknown-environment'

  return [
    rawMessage,
    `Railway project tokens only work against the project they were created for.`,
    `Request targeted projectId=${targetProjectId} environmentId=${targetEnvironmentId} using Project-Access-Token.`,
    `Verify CLAWNOW_RAILWAY_API_TOKEN belongs to that same Railway project, or switch to CLAWNOW_RAILWAY_TOKEN_TYPE=workspace/account with a bearer token.`,
  ].join(' ')
}

function isMissingGraphqlField(error: unknown, fieldName: string) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(`Cannot query field "${fieldName}"`)
}

export class RailwayInfraProvider implements InfraProvider {
  async ensureProjectWebhook(input: {
    projectId: string
    url: string
  }): Promise<{ created: boolean; webhook: RailwayProjectWebhook }> {
    const normalizedUrl = normalizeWebhookUrl(input.url)

    try {
      const existingWebhook = await this.findProjectWebhookByUrl({
        projectId: input.projectId,
        url: normalizedUrl,
      })

      if (existingWebhook) {
        logRailway('ensureProjectWebhook.reused', {
          projectId: input.projectId,
          webhookId: existingWebhook.id,
          url: existingWebhook.url,
        })

        return {
          created: false,
          webhook: existingWebhook,
        }
      }
    } catch (error) {
      logRailwayWarn('ensureProjectWebhook.lookupFailed', {
        projectId: input.projectId,
        url: normalizedUrl,
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    const webhook = await this.createProjectWebhook({
      projectId: input.projectId,
      url: normalizedUrl,
    })

    logRailway('ensureProjectWebhook.created', {
      projectId: input.projectId,
      webhookId: webhook.id,
      url: webhook.url,
    })

    return {
      created: true,
      webhook,
    }
  }

  async createVm(input: {
    region: string
    sizeSlug: string
    maxInstances: number
    hostname?: string
    userData?: string
  }): Promise<ProvisionedVm> {
    void input.userData
    logRailway('createVm.start', {
      region: input.region,
      sizeSlug: input.sizeSlug,
      hostname: input.hostname,
      maxInstances: input.maxInstances,
    })

    if (!env.CLAWNOW_RAILWAY_API_TOKEN) {
      logRailway('createVm.dryrun', {
        reason: 'CLAWNOW_RAILWAY_API_TOKEN missing',
      })
      const id = makeProviderVmId({
        projectId: `dryrun-project-${randomUUID()}`,
        environmentId: `dryrun-env-${randomUUID()}`,
        serviceId: `dryrun-service-${randomUUID()}`,
      })

      return {
        provider: provider(),
        providerVmId: id,
        name: input.hostname || 'clawnow-openclaw',
        hostname: input.hostname || 'clawnow-openclaw',
        region: input.region,
        sizeSlug: input.sizeSlug,
        cpuTotalMillicores: 0,
        memoryTotalMb: 0,
        diskTotalGb: 5,
        maxInstances: 1,
        status: 'PROVISIONING',
      }
    }

    if (
      env.CLAWNOW_RAILWAY_TOKEN_TYPE === 'project' &&
      (!env.CLAWNOW_RAILWAY_PROJECT_ID || !env.CLAWNOW_RAILWAY_ENVIRONMENT_ID)
    ) {
      throw new Error(
        'CLAWNOW_RAILWAY_PROJECT_ID and CLAWNOW_RAILWAY_ENVIRONMENT_ID are required when CLAWNOW_RAILWAY_TOKEN_TYPE=project',
      )
    }

    const projectName = sanitizeName(input.hostname || `clawnow-${randomUUID().slice(0, 8)}`)
    try {
      const fixedProject = this.getFixedProjectConfig()
      const projectId = fixedProject?.projectId ?? (await this.createProject(projectName))
      const environmentId = fixedProject?.environmentId ?? (await this.getPrimaryEnvironmentId(projectId))
      const serviceId = await this.createService({
        projectId,
        environmentId,
        name: projectName,
        repo: env.CLAWNOW_RAILWAY_TEMPLATE_REPO,
        branch: env.CLAWNOW_RAILWAY_TEMPLATE_BRANCH,
      })

      const provisionedVm = {
        provider: provider(),
        providerVmId: makeProviderVmId({
          projectId,
          environmentId,
          serviceId,
        }),
        name: projectName,
        hostname: projectName,
        region: input.region,
        sizeSlug: input.sizeSlug,
        cpuTotalMillicores: 0,
        memoryTotalMb: 0,
        diskTotalGb: 5,
        maxInstances: 1,
        status: 'PROVISIONING' as const,
      }

      logRailway('createVm.success', {
        projectId,
        environmentId,
        serviceId,
        usingFixedProject: Boolean(fixedProject),
        providerVmId: provisionedVm.providerVmId,
      })

      return provisionedVm
    } catch (error) {
      logRailwayError('createVm', error, {
        projectName,
      })
      throw error
    }
  }

  async getVm(providerVmId: string): Promise<ProvisionedVm | null> {
    if (!env.CLAWNOW_RAILWAY_API_TOKEN) {
      logRailway('getVm.skipped', {
        providerVmId,
        reason: 'CLAWNOW_RAILWAY_API_TOKEN missing',
      })
      return null
    }

    const { projectId, environmentId, serviceId, deploymentId } = parseRailwayProviderVmId(providerVmId)
    let deploymentStatus: string | undefined
    let latestDeploymentId: string | undefined
    let latestDeploymentStatus: string | undefined
    let publicUrl: string | undefined
    let serviceName: string | undefined

    try {
      const snapshot = await this.getServiceSnapshot(serviceId)
      latestDeploymentId = snapshot.deploymentId
      latestDeploymentStatus = snapshot.deploymentStatus
      publicUrl = snapshot.publicUrl
      serviceName = snapshot.serviceName
    } catch (error) {
      logRailwayWarn('getVm.serviceSnapshotUnavailable', {
        providerVmId,
        projectId,
        environmentId,
        serviceId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    if (deploymentId) {
      try {
        const response = await this.graphql<{
          deployment?: {
            id?: string
            status?: string
          } | null
        }>(
          `
            query GetDeployment($deploymentId: String!) {
              deployment(id: $deploymentId) {
                id
                status
              }
            }
          `,
          { deploymentId },
        )

        deploymentStatus = response.deployment?.status
        logRailway('getVm.deploymentStatus', {
          providerVmId,
          projectId,
          environmentId,
          serviceId,
          deploymentId,
          deploymentStatus,
          mappedStatus: mapRailwayDeploymentStatus(deploymentStatus),
        })
      } catch (error) {
        logRailwayError('getVm.deploymentStatus', error, {
          providerVmId,
          projectId,
          environmentId,
          serviceId,
          deploymentId,
        })

        if (!latestDeploymentStatus) {
          throw error
        }
      }
    }

    if (!deploymentStatus && !latestDeploymentStatus && !publicUrl && !serviceName) {
      logRailwayWarn('getVm.unknownStatus', {
        providerVmId,
        projectId,
        environmentId,
        serviceId,
        deploymentId: deploymentId || null,
      })
      return null
    }

    const snapshot = buildRailwayVmSnapshot({
      projectId,
      environmentId,
      serviceId,
      deploymentId,
      latestDeploymentId,
      deploymentStatus,
      latestDeploymentStatus,
      publicUrl,
      serviceName,
    })

    logRailway('getVm.snapshot', {
      providerVmId,
      resolvedProviderVmId: snapshot.providerVmId,
      projectId,
      environmentId,
      serviceId,
      deploymentId: deploymentId || null,
      latestDeploymentId: latestDeploymentId || null,
      deploymentStatus: deploymentStatus || null,
      latestDeploymentStatus: latestDeploymentStatus || null,
      publicUrl: publicUrl || null,
      mappedStatus: snapshot.status,
    })

    return snapshot
  }

  async deleteVm(providerVmId: string): Promise<void> {
    if (!env.CLAWNOW_RAILWAY_API_TOKEN) {
      logRailway('deleteVm.skipped', {
        providerVmId,
        reason: 'CLAWNOW_RAILWAY_API_TOKEN missing',
      })
      return
    }

    const { projectId, serviceId } = parseRailwayProviderVmId(providerVmId)
    logRailway('deleteVm.start', {
      providerVmId,
      projectId,
      serviceId,
    })

    try {
      await this.graphql(
        `
          mutation DeleteService($id: String!) {
            serviceDelete(id: $id)
          }
        `,
        { id: serviceId },
      )
      logRailway('deleteVm.success', {
        providerVmId,
        projectId,
        serviceId,
      })
    } catch (error) {
      logRailwayError('deleteVm', error, {
        providerVmId,
        projectId,
        serviceId,
      })
      throw error
    }
  }

  async createVolume(input: {
    instanceId: string
    providerVmId?: string
    region: string
    sizeGb: number
    mountPath: string
  }): Promise<ProvisionedVolume> {
    if (!input.providerVmId) {
      throw new Error('Railway volume creation requires providerVmId')
    }
    logRailway('createVolume.start', {
      instanceId: input.instanceId,
      providerVmId: input.providerVmId,
      mountPath: input.mountPath,
      region: input.region,
      sizeGb: input.sizeGb,
    })

    if (!env.CLAWNOW_RAILWAY_API_TOKEN) {
      logRailway('createVolume.dryrun', {
        instanceId: input.instanceId,
      })
      return {
        provider: provider(),
        providerVolumeId: `dryrun-volume-${randomUUID()}`,
        region: input.region,
        sizeGb: input.sizeGb,
        mountPath: input.mountPath,
      }
    }

    const { projectId, environmentId, serviceId } = parseRailwayProviderVmId(input.providerVmId)
    const variables: Record<string, unknown> = {
      projectId,
      environmentId,
      serviceId,
      mountPath: input.mountPath,
    }

    let response: { volumeCreate?: { id?: string } | null }
    try {
      response = await this.graphql(
        `
          mutation VolumeCreate(
            $projectId: String!
            $environmentId: String!
            $serviceId: String!
            $mountPath: String!
            $region: String
          ) {
            volumeCreate(
              input: {
                projectId: $projectId
                environmentId: $environmentId
                serviceId: $serviceId
                mountPath: $mountPath
                region: $region
              }
            ) {
              id
            }
          }
        `,
        {
          ...variables,
          region: env.CLAWNOW_RAILWAY_VOLUME_REGION,
        },
      )
      logRailway('createVolume.withRegion.success', {
        projectId,
        environmentId,
        serviceId,
      })
    } catch (error) {
      logRailwayError('createVolume.withRegion', error, {
        projectId,
        environmentId,
        serviceId,
        region: env.CLAWNOW_RAILWAY_VOLUME_REGION,
      })
      response = await this.graphql(
        `
          mutation VolumeCreate(
            $projectId: String!
            $environmentId: String!
            $serviceId: String!
            $mountPath: String!
          ) {
            volumeCreate(
              input: {
                projectId: $projectId
                environmentId: $environmentId
                serviceId: $serviceId
                mountPath: $mountPath
              }
            ) {
              id
            }
          }
        `,
        variables,
      )
      logRailway('createVolume.fallback.success', {
        projectId,
        environmentId,
        serviceId,
      })
    }

    const providerVolumeId = response.volumeCreate?.id
    if (!providerVolumeId) {
      logRailwayError('createVolume', 'volume id missing', {
        projectId,
        environmentId,
        serviceId,
      })
      throw new Error('Railway volume creation did not return a volume id')
    }

    logRailway('createVolume.success', {
      instanceId: input.instanceId,
      providerVolumeId,
      projectId,
      environmentId,
      serviceId,
    })

    return {
      provider: provider(),
      providerVolumeId,
      region: input.region,
      sizeGb: input.sizeGb,
      mountPath: input.mountPath,
    }
  }

  async attachVolume(_input: { providerVmId: string; providerVolumeId: string }): Promise<void> {
    return
  }

  async detachVolume(_input: { providerVmId: string; providerVolumeId: string }): Promise<void> {
    return
  }

  async configureInstanceRuntime(input: {
    providerVmId: string
    instanceId: string
    name: string
    region: string
    imageTag: string
    setupPassword: string
    mountPath: string
  }) {
    const { projectId, environmentId, serviceId } = parseRailwayProviderVmId(input.providerVmId)
    logRailway('configureInstanceRuntime.start', {
      instanceId: input.instanceId,
      providerVmId: input.providerVmId,
      projectId,
      environmentId,
      serviceId,
      imageTag: input.imageTag,
      mountPath: input.mountPath,
    })

    const gatewayToken = randomBytesToken()

    if (!env.CLAWNOW_RAILWAY_API_TOKEN) {
      logRailway('configureInstanceRuntime.dryrun', {
        instanceId: input.instanceId,
      })
      return {
        providerVmId: makeProviderVmId({
          projectId,
          environmentId,
          serviceId,
          deploymentId: `dryrun-deployment-${randomUUID()}`,
        }),
        publicUrl: `https://${sanitizeName(input.name)}.up.railway.app`,
        status: 'ACTIVE' as const,
        gatewayToken,
      }
    }

    try {
      await this.graphql(
        `
          mutation UpsertVariables(
            $variables: VariableCollectionUpsertInput!
          ) {
            variableCollectionUpsert(input: $variables)
          }
        `,
        {
          variables: {
            projectId,
            environmentId,
            serviceId,
            variables: {
              SETUP_PASSWORD: input.setupPassword,
              OPENCLAW_STATE_DIR: `${input.mountPath}/.openclaw`,
              OPENCLAW_WORKSPACE_DIR: `${input.mountPath}/workspace`,
              OPENCLAW_VERSION: input.imageTag,
              OPENCLAW_GATEWAY_TOKEN: gatewayToken,
              ENABLE_WEB_TUI: 'true',
              PORT: String(env.CLAWNOW_RAILWAY_TARGET_PORT),
              INTERNAL_GATEWAY_PORT: String(env.CLAWNOW_RAILWAY_INTERNAL_GATEWAY_PORT),
            },
          },
        },
      )
      logRailway('configureInstanceRuntime.variables.success', {
        projectId,
        environmentId,
        serviceId,
      })

      const publicUrl = await this.ensureDomain({
        serviceId,
        environmentId,
      })

      const deploymentId = await this.deployService({
        serviceId,
        environmentId,
      })

      logRailway('configureInstanceRuntime.success', {
        instanceId: input.instanceId,
        projectId,
        environmentId,
        serviceId,
        deploymentId,
        publicUrl,
      })

      return {
        providerVmId: makeProviderVmId({
          projectId,
          environmentId,
          serviceId,
          deploymentId,
        }),
        publicUrl,
        status: deploymentId ? ('PROVISIONING' as const) : ('ACTIVE' as const),
        gatewayToken,
      }
    } catch (error) {
      logRailwayError('configureInstanceRuntime', error, {
        instanceId: input.instanceId,
        projectId,
        environmentId,
        serviceId,
      })
      throw error
    }
  }

  private async createProject(name: string) {
    logRailway('createProject.start', {
      name,
      workspaceId: env.CLAWNOW_RAILWAY_WORKSPACE_ID || null,
    })
    const response = await this.graphql<{
      projectCreate?: { id?: string } | null
    }>(
      `
        mutation CreateProject($name: String!, $workspaceId: String) {
          projectCreate(input: { name: $name, workspaceId: $workspaceId }) {
            id
          }
        }
      `,
      {
        name,
        workspaceId: env.CLAWNOW_RAILWAY_WORKSPACE_ID,
      },
    )

    const projectId = response.projectCreate?.id
    if (!projectId) {
      throw new Error('Railway project creation did not return a project id')
    }

    logRailway('createProject.success', {
      name,
      projectId,
    })

    return projectId
  }

  private getFixedProjectConfig() {
    if (!env.CLAWNOW_RAILWAY_PROJECT_ID || !env.CLAWNOW_RAILWAY_ENVIRONMENT_ID) {
      return null
    }

    return {
      projectId: env.CLAWNOW_RAILWAY_PROJECT_ID,
      environmentId: env.CLAWNOW_RAILWAY_ENVIRONMENT_ID,
    }
  }

  private async getPrimaryEnvironmentId(projectId: string) {
    logRailway('getPrimaryEnvironmentId.start', {
      projectId,
    })
    const response = await this.graphql<{
      project?: {
        environments?: unknown
      } | null
    }>(
      `
        query GetProjectEnvironments($projectId: String!) {
          project(id: $projectId) {
            environments {
              edges {
                node {
                  id
                  name
                  isEphemeral
                }
              }
            }
          }
        }
      `,
      { projectId },
    )

    const environments = collectEnvironmentNodes(response.project?.environments)
    const environment =
      environments.find((item) => !item.isEphemeral && /prod/i.test(item.name || '')) ??
      environments.find((item) => !item.isEphemeral) ??
      environments[0]

    if (!environment?.id) {
      throw new Error('Railway project did not expose an environment id')
    }

    logRailway('getPrimaryEnvironmentId.success', {
      projectId,
      environmentId: environment.id,
      environmentName: environment.name || null,
    })

    return environment.id
  }

  private async createService(input: {
    projectId: string
    environmentId: string
    name: string
    repo: string
    branch: string
  }) {
    logRailway('createService.start', {
      projectId: input.projectId,
      environmentId: input.environmentId,
      name: input.name,
      repo: input.repo,
      branch: input.branch,
    })
    try {
      const response = await this.graphql<{
        serviceCreate?: { id?: string } | null
      }>(
        `
          mutation CreateService(
            $projectId: String!
            $environmentId: String!
            $name: String!
            $repo: String!
            $branch: String!
          ) {
            serviceCreate(
              input: {
                projectId: $projectId
                environmentId: $environmentId
                name: $name
                source: { repo: $repo }
                branch: $branch
              }
            ) {
              id
            }
          }
        `,
        input,
      )

      const serviceId = response.serviceCreate?.id
      if (!serviceId) {
        throw new Error('Railway service creation did not return a service id')
      }

      logRailway('createService.success', {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId,
      })

      return serviceId
    } catch (error) {
      logRailwayError('createService.primary', error, {
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.name,
      })
      const response = await this.graphql<{
        serviceCreate?: { id?: string } | null
      }>(
        `
          mutation CreateService(
            $projectId: String!
            $name: String!
            $repo: String!
            $branch: String!
          ) {
            serviceCreate(
              input: {
                projectId: $projectId
                name: $name
                source: { repo: $repo }
                branch: $branch
              }
            ) {
              id
            }
          }
        `,
        {
          projectId: input.projectId,
          name: input.name,
          repo: input.repo,
          branch: input.branch,
        },
      )

      const serviceId = response.serviceCreate?.id
      if (!serviceId) {
        throw new Error('Railway service creation did not return a service id')
      }

      logRailway('createService.fallback.success', {
        projectId: input.projectId,
        serviceId,
      })

      return serviceId
    }
  }

  private async ensureDomain(input: { serviceId: string; environmentId: string }) {
    logRailway('ensureDomain.start', input)
    try {
      const response = await this.graphql<{
        serviceDomainCreate?: unknown
      }>(
        `
          mutation CreateDomain($serviceId: String!, $environmentId: String!, $targetPort: Int!) {
            serviceDomainCreate(
              input: {
                serviceId: $serviceId
                environmentId: $environmentId
                targetPort: $targetPort
              }
            ) {
              id
              domain
            }
          }
        `,
        {
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          targetPort: env.CLAWNOW_RAILWAY_TARGET_PORT,
        },
      )

      const domain = pickDomain(response.serviceDomainCreate)
      logRailway('ensureDomain.success', {
        ...input,
        domain: domain || null,
      })
      return domain ? `https://${domain}` : undefined
    } catch (error) {
      logRailwayError('ensureDomain.primary', error, input)
      const response = await this.graphql<{
        serviceDomainCreate?: unknown
      }>(
        `
          mutation CreateDomain($serviceId: String!, $environmentId: String!) {
            serviceDomainCreate(
              input: {
                serviceId: $serviceId
                environmentId: $environmentId
              }
            ) {
              id
              domain
            }
          }
        `,
        input,
      )

      const domain = pickDomain(response.serviceDomainCreate)
      logRailway('ensureDomain.fallback.success', {
        ...input,
        domain: domain || null,
      })
      return domain ? `https://${domain}` : undefined
    }
  }

  private async getServiceSnapshot(serviceId: string) {
    const response = await this.graphql<{
      service?: {
        name?: string
        deployments?: unknown
      } | null
    }>(
      `
        query GetServiceSnapshot($serviceId: String!) {
          service(id: $serviceId) {
            name
            deployments(first: 1) {
              edges {
                node {
                  id
                  status
                }
              }
            }
          }
        }
      `,
      { serviceId },
    )

    const deployment = pickDeploymentSnapshot(response.service?.deployments)

    return {
      serviceName: asString(response.service?.name),
      deploymentId: deployment?.id,
      deploymentStatus: deployment?.status,
      publicUrl: undefined,
    }
  }

  private async findProjectWebhookByUrl(input: { projectId: string; url: string }) {
    const webhooks = await this.listProjectWebhooks(input.projectId)
    const normalizedUrl = normalizeWebhookUrl(input.url)

    return webhooks.find((webhook) => normalizeWebhookUrl(webhook.url) === normalizedUrl) ?? null
  }

  private async listProjectWebhooks(projectId: string) {
    try {
      const response = await this.graphql<{
        webhooks?: unknown
      }>(
        `
          query ProjectWebhooks($projectId: String!, $first: Int!) {
            webhooks(projectId: $projectId, first: $first) {
              edges {
                node {
                  id
                  projectId
                  url
                  lastStatus
                }
              }
            }
          }
        `,
        { projectId, first: 100 },
      )

      return collectConnectionNodes(response.webhooks)
        .map((node) => parseRailwayWebhook(node))
        .filter(Boolean) as RailwayProjectWebhook[]
    } catch (error) {
      if (!isMissingGraphqlField(error, 'webhooks')) {
        throw error
      }

      const response = await this.graphql<{
        railway?: {
          webhooks?: unknown
        } | null
      }>(
        `
          query ProjectWebhooks($projectId: String!, $first: Int!) {
            railway {
              webhooks(projectId: $projectId, first: $first) {
                edges {
                  node {
                    id
                    projectId
                    url
                    lastStatus
                  }
                }
              }
            }
          }
        `,
        { projectId, first: 100 },
      )

      return collectConnectionNodes(response.railway?.webhooks)
        .map((node) => parseRailwayWebhook(node))
        .filter(Boolean) as RailwayProjectWebhook[]
    }
  }

  private async createProjectWebhook(input: { projectId: string; url: string }) {
    try {
      const response = await this.graphql<{
        webhookCreate?: unknown
      }>(
        `
          mutation CreateWebhook($projectId: String!, $url: String!) {
            webhookCreate(input: { projectId: $projectId, url: $url }) {
              id
              projectId
              url
              lastStatus
            }
          }
        `,
        input,
      )

      const webhook = parseRailwayWebhook(response.webhookCreate)
      if (!webhook) {
        throw new Error('Railway webhook creation did not return a webhook id and url')
      }

      return webhook
    } catch (error) {
      if (!isMissingGraphqlField(error, 'webhookCreate')) {
        throw error
      }
      throw new Error(
        'Railway public GraphQL currently exposes webhook reads but not a webhookCreate mutation for this schema. Configure the project webhook in the Railway dashboard for now.',
      )
    }
  }

  private async deployService(input: { serviceId: string; environmentId: string }) {
    logRailway('deployService.start', input)
    const response = await this.graphql<{
      serviceInstanceDeploy?: string | { id?: string } | null
    }>(
      `
        mutation DeployService($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeploy(
            latestCommit: true
            serviceId: $serviceId
            environmentId: $environmentId
          )
        }
      `,
      input,
    )

    const deploymentId =
      asString(response.serviceInstanceDeploy) ||
      pickId(response.serviceInstanceDeploy)

    if (!deploymentId) {
      logRailwayWarn('deployService.missingDeploymentId', {
        ...input,
        response,
      })
      return undefined
    }

    logRailway('deployService.success', {
      ...input,
      deploymentId,
      mutation: 'serviceInstanceDeploy',
    })

    return deploymentId
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!env.CLAWNOW_RAILWAY_API_TOKEN) {
      throw new Error('CLAWNOW_RAILWAY_API_TOKEN is not configured')
    }

    const operationMatch = query.match(/(?:mutation|query)\s+([A-Za-z0-9_]+)/)
    const operationName = operationMatch?.[1] || 'anonymous'
    const authHeaderName =
      env.CLAWNOW_RAILWAY_TOKEN_TYPE === 'project' ? 'Project-Access-Token' : 'Authorization'
    const authHeaderValue =
      env.CLAWNOW_RAILWAY_TOKEN_TYPE === 'project'
        ? env.CLAWNOW_RAILWAY_API_TOKEN
        : `Bearer ${env.CLAWNOW_RAILWAY_API_TOKEN}`
    logRailway('graphql.request', {
      operationName,
      authHeaderName,
      variableKeys: variables ? Object.keys(variables) : [],
    })

    const response = await fetch(env.CLAWNOW_RAILWAY_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        [authHeaderName]: authHeaderValue,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      logRailwayError('graphql.http', `${response.status} ${text.trim()}`, {
        operationName,
      })
      throw new Error(`Railway GraphQL request failed: ${response.status} ${text.trim()}`)
    }

    const body = (await response.json()) as {
      data?: T
      errors?: Array<{ message?: string }>
    }

    if (body.errors?.length) {
      const message = formatGraphqlErrorMessage(
        operationName,
        body.errors.map((error) => error.message || 'Unknown Railway GraphQL error').join(' | '),
        variables,
      )
      logRailwayError(
        'graphql.response',
        message,
        { operationName },
      )
      throw new Error(message)
    }

    if (!body.data) {
      logRailwayError('graphql.response', 'Railway GraphQL request returned no data', {
        operationName,
      })
      throw new Error('Railway GraphQL request returned no data')
    }

    logRailway('graphql.success', {
      operationName,
    })

    return body.data
  }
}

function randomBytesToken() {
  return randomUUID().replace(/-/g, '')
}
