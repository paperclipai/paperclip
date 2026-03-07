import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: bigint | number): string {
  const num = typeof bytes === 'bigint' ? Number(bytes) : bytes
  if (num === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(num) / Math.log(k))

  return `${parseFloat((num / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function formatCycles(cycles: bigint | number): string {
  const num = typeof cycles === 'bigint' ? Number(cycles) : cycles
  if (num < 1_000_000) {
    return `${num.toLocaleString()} T`
  }
  if (num < 1_000_000_000) {
    return `${(num / 1_000_000).toFixed(2)} M`
  }
  if (num < 1_000_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(2)} G`
  }
  return `${(num / 1_000_000_000_000).toFixed(2)} T`
}

export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  
  return date.toLocaleDateString()
}

export function formatDateTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString()
}

export function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString()
}

export function truncate(str: string, length: number = 20): string {
  if (str.length <= length) return str
  return `${str.slice(0, length)}...`
}

export function truncatePrincipal(principal: string, length: number = 8): string {
  if (principal.length <= length * 2) return principal
  return `${principal.slice(0, length)}...${principal.slice(-length)}`
}

export function getStatusColor(status: string): string {
  const statusMap: Record<string, string> = {
    running: 'text-green-500',
    active: 'text-green-500',
    connected: 'text-green-500',
    completed: 'text-green-500',
    approved: 'text-green-500',
    uploading: 'text-blue-500',
    deploying: 'text-blue-500',
    pending: 'text-yellow-500',
    starting: 'text-yellow-500',
    stopped: 'text-gray-500',
    inactive: 'text-gray-500',
    disconnected: 'text-gray-500',
    stopping: 'text-orange-500',
    error: 'text-red-500',
    failed: 'text-red-500',
    rejected: 'text-red-500',
    degraded: 'text-orange-500',
    expired: 'text-gray-500',
  }
  return statusMap[status.toLowerCase()] || 'text-gray-500'
}

export function getStatusBgColor(status: string): string {
  const statusMap: Record<string, string> = {
    running: 'bg-green-500',
    active: 'bg-green-500',
    connected: 'bg-green-500',
    completed: 'bg-green-500',
    approved: 'bg-green-500',
    uploading: 'bg-blue-500',
    deploying: 'bg-blue-500',
    pending: 'bg-yellow-500',
    starting: 'bg-yellow-500',
    stopped: 'bg-gray-500',
    inactive: 'bg-gray-500',
    disconnected: 'bg-gray-500',
    stopping: 'bg-orange-500',
    error: 'bg-red-500',
    failed: 'bg-red-500',
    rejected: 'bg-red-500',
    degraded: 'bg-orange-500',
    expired: 'bg-gray-500',
  }
  return statusMap[status.toLowerCase()] || 'bg-gray-500'
}
