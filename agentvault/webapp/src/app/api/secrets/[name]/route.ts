import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'

const SECRETS_PROVIDER = process.env.SECRETS_PROVIDER || 'environment'

interface SecretResponse {
  name: string
  value: string
  provider: string
  rotatedAt?: string
}

async function getSecretFromProvider(name: string): Promise<{ value: string; rotatedAt?: string } | null> {
  if (SECRETS_PROVIDER === 'hashicorp') {
    const vaultAddr = process.env.VAULT_ADDR
    const vaultToken = process.env.VAULT_TOKEN
    
    if (!vaultAddr || !vaultToken) {
      return null
    }
    
    try {
      const response = await fetch(`${vaultAddr}/v1/secret/data/${name}`, {
        headers: {
          'X-Vault-Token': vaultToken,
        },
      })
      
      if (!response.ok) {
        return null
      }
      
      const data = await response.json() as { data?: { data?: { value?: string; rotated_at?: string } } }
      const secretData = data.data?.data
      
      if (!secretData?.value) {
        return null
      }
      
      return {
        value: secretData.value,
        rotatedAt: secretData.rotated_at,
      }
    } catch {
      return null
    }
  }
  
  const value = process.env[name]
  if (!value) {
    return null
  }
  
  return { value }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { name } = await params

  try {
    const secret = await getSecretFromProvider(name)
    
    if (!secret) {
      return NextResponse.json(
        { success: false, error: { message: `Secret not found: ${name}`, code: 'SECRET_NOT_FOUND' } },
        { status: 404 }
      )
    }

    const response: SecretResponse = {
      name,
      value: secret.value,
      provider: SECRETS_PROVIDER,
      rotatedAt: secret.rotatedAt,
    }

    return NextResponse.json({ success: true, data: response })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
