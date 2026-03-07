import { Actor, HttpAgent } from '@dfinity/agent'

export type NetworkMode = 'local' | 'mainnet' | 'ic'

export interface ICPConnectionConfig {
  network: NetworkMode
  localUrl: string
  mainnetUrl: string
  host: string
}

export const DEFAULT_ICP_CONFIG: ICPConnectionConfig = {
  network: 'local',
  localUrl: 'http://127.0.0.1:4943',
  mainnetUrl: 'https://ic0.app',
  host: 'http://127.0.0.1:4943',
}

export function getICPNetworkConfig(): ICPConnectionConfig {
  const network = (process.env.NEXT_PUBLIC_ICP_NETWORK as NetworkMode) || 'local'
  return {
    network,
    localUrl: process.env.NEXT_PUBLIC_ICP_LOCAL_URL || 'http://127.0.0.1:4943',
    mainnetUrl: process.env.NEXT_PUBLIC_ICP_MAINNET_URL || 'https://ic0.app',
    host: network === 'local'
      ? process.env.NEXT_PUBLIC_ICP_LOCAL_URL || 'http://127.0.0.1:4943'
      : process.env.NEXT_PUBLIC_ICP_MAINNET_URL || 'https://ic0.app',
  }
}

export async function createAgent(config?: Partial<ICPConnectionConfig>): Promise<HttpAgent> {
  const finalConfig = { ...getICPNetworkConfig(), ...config }

  const agent = new HttpAgent({
    host: finalConfig.host,
  })

  if (finalConfig.network === 'local') {
    await agent.fetchRootKey()
  }

  return agent
}

export interface CanisterConfig {
  canisterId: string
  idlFactory: any
}

export async function createActor<T>(
  config: CanisterConfig,
  agent?: HttpAgent
): Promise<T> {
  const finalAgent = agent || await createAgent()

  return Actor.createActor(config.idlFactory, {
    agent: finalAgent,
    canisterId: config.canisterId,
  }) as T
}

export function getCanisterUrl(canisterId: string): string {
  const config = getICPNetworkConfig()
  if (config.network === 'local') {
    return `${config.localUrl}/?canisterId=${canisterId}`
  }
  return `https://${canisterId}.ic0.app`
}

export function isValidPrincipal(principal: string): boolean {
  return /^[a-z0-9\-]{5,63}$/.test(principal)
}

export function getLocalCanisterId(canisterName: string): string {
  const canisterIds: Record<string, string> = {
    agent_vault_backend: process.env.AGENT_VAULT_BACKEND_CANISTER_ID || '',
    agent_vault_frontend: process.env.AGENT_VAULT_FRONTEND_CANISTER_ID || '',
  }
  return canisterIds[canisterName] || ''
}
