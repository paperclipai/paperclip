import { canisterStatus } from '@/icp/icpcli.js'

export interface ParsedCanisterStatus {
  status: 'running' | 'stopped' | 'stopping' | 'starting' | 'error'
  memory: number
  cycles: number
  controller: string
}

function parseNumericValue(value: string | undefined): number {
  if (!value) {
    return 0
  }

  const normalized = value.replaceAll('_', '')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function mapStatus(raw: string): ParsedCanisterStatus['status'] {
  const normalized = raw.toLowerCase()
  if (normalized.includes('running')) return 'running'
  if (normalized.includes('stopping')) return 'stopping'
  if (normalized.includes('starting')) return 'starting'
  if (normalized.includes('stop')) return 'stopped'
  return 'error'
}

export function parseCanisterStatusOutput(output: string): ParsedCanisterStatus {
  const trimmed = output.trim()

  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>
      const statusRaw = typeof json.status === 'string' ? json.status : 'stopped'
      const memoryRaw = typeof json.memory_size === 'string' ? json.memory_size : undefined
      const cyclesRaw =
        typeof json.cycles === 'string'
          ? json.cycles
          : typeof json.balance === 'string'
            ? json.balance
            : undefined

      return {
        status: mapStatus(statusRaw),
        memory: parseNumericValue(memoryRaw),
        cycles: parseNumericValue(cyclesRaw),
        controller: 'unknown',
      }
    } catch {
      return {
        status: 'error',
        memory: 0,
        cycles: 0,
        controller: 'unknown',
      }
    }
  }

  const statusMatch = trimmed.match(/Status:\s*(\w+)/i)
  const memoryMatch = trimmed.match(/Memory Size:\s*([\d_]+)/i)
  const cyclesMatch = trimmed.match(/(?:Balance|Cycles):\s*([\d_]+)/i)
  const controllerMatch = trimmed.match(/Controller(?:s)?:\s*([a-z0-9-]+)/i)

  return {
    status: mapStatus(statusMatch?.[1] ?? 'stopped'),
    memory: parseNumericValue(memoryMatch?.[1]),
    cycles: parseNumericValue(cyclesMatch?.[1]),
    controller: controllerMatch?.[1] ?? 'unknown',
  }
}

export async function getCanisterStatusSafe(canisterId: string): Promise<ParsedCanisterStatus | null> {
  try {
    const result = await canisterStatus({
      canister: canisterId,
    })
    return parseCanisterStatusOutput(result.stdout)
  } catch {
    return null
  }
}
