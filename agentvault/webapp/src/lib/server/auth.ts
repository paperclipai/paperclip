import { NextRequest, NextResponse } from 'next/server'

const API_TOKEN_ENV_VAR = 'AGENTVAULT_POLYTICIAN_API_TOKEN'

export interface AuthResult {
  authorized: boolean
  error?: string
}

export function validateAuthToken(request: NextRequest): AuthResult {
  const authHeader = request.headers.get('authorization')
  
  if (!authHeader) {
    return { authorized: false, error: 'Missing Authorization header' }
  }
  
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return { authorized: false, error: 'Invalid Authorization header format. Expected: Bearer <token>' }
  }
  
  const token = parts[1]
  const expectedToken = process.env[API_TOKEN_ENV_VAR]
  
  if (!expectedToken) {
    console.error(`[${API_TOKEN_ENV_VAR}] environment variable is not set`)
    return { authorized: false, error: 'Server configuration error' }
  }
  
  if (token !== expectedToken) {
    return { authorized: false, error: 'Invalid API token' }
  }
  
  return { authorized: true }
}

export function unauthorizedResponse(error: string): NextResponse {
  return NextResponse.json(
    { success: false, error: { message: error, code: 'UNAUTHORIZED' } },
    { status: 401 }
  )
}

export function withAuth(
  request: NextRequest,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  
  if (!authResult.authorized) {
    return Promise.resolve(unauthorizedResponse(authResult.error ?? 'Unauthorized'))
  }
  
  return handler()
}
