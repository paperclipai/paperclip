import type { ApiError, ApiResponse, PageParams } from './types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api'

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${endpoint}`
  const config: RequestInit = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }

  try {
    const response = await fetch(url, config)
    const payload = await response.json().catch(() => null)

    if (isEnvelope(payload)) {
      if (!payload.success) {
        return {
          success: false,
          error: toApiError(payload.error, 'Request failed'),
        }
      }

      return {
        success: true,
        data: payload.data as T,
      }
    }

    if (!response.ok) {
      return {
        success: false,
        error: toApiError(payload, 'Request failed'),
      }
    }

    return {
      success: true,
      data: payload as T,
    }
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'NETWORK_ERROR',
      },
    }
  }
}

interface ApiEnvelope {
  success: boolean
  data?: unknown
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isEnvelope(value: unknown): value is ApiEnvelope {
  return isRecord(value) && typeof value.success === 'boolean'
}

function toApiError(raw: unknown, fallbackMessage: string): ApiError {
  if (typeof raw === 'string') {
    return { message: raw }
  }

  if (isRecord(raw) && 'error' in raw) {
    return toApiError(raw.error, fallbackMessage)
  }

  if (isRecord(raw)) {
    const message =
      (typeof raw.message === 'string' ? raw.message : undefined) ??
      fallbackMessage
    const code = typeof raw.code === 'string' ? raw.code : undefined
    const details = raw.details
    return {
      message,
      code,
      details,
    }
  }

  return {
    message: fallbackMessage,
  }
}

export const apiClient = {
  get: <T>(endpoint: string, params?: PageParams) => {
    const query = params ? `?${new URLSearchParams(params as Record<string, string>)}` : ''
    return request<T>(`${endpoint}${query}`, { method: 'GET' })
  },

  post: <T>(endpoint: string, body?: unknown) => {
    return request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  put: <T>(endpoint: string, body?: unknown) => {
    return request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  },

  delete: <T>(endpoint: string) => {
    return request<T>(endpoint, { method: 'DELETE' })
  },
}

export default apiClient
