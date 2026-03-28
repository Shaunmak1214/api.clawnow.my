import { env } from '../config/env.js'
import { ContaboInfraProvider } from './contabo-infra-provider.js'
import { DigitalOceanInfraProvider } from './digitalocean-infra-provider.js'
import type { InfraProvider } from './interfaces.js'

export function createInfraProvider(): InfraProvider {
  if (env.INFRA_PROVIDER === 'contabo') {
    return new ContaboInfraProvider()
  }

  return new DigitalOceanInfraProvider()
}
