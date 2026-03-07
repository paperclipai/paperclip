import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { ArweaveClient } from '@/archival/arweave-client.js'

interface UploadRequest {
  data: string
  tags?: Record<string, string>
  metadata?: Record<string, unknown>
  jwk?: {
    kty: string
    n: string
    e: string
    d?: string
    p?: string
    q?: string
    dp?: string
    dq?: string
    qi?: string
  }
}

interface UploadResponse {
  txId: string
  url: string
  timestamp: string
  tags: Record<string, string>
  size: number
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  try {
    const body: UploadRequest = await request.json()
    
    if (!body.data) {
      return NextResponse.json(
        { success: false, error: { message: 'Missing required field: data', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    if (!body.jwk) {
      return NextResponse.json(
        { success: false, error: { message: 'Missing required field: jwk (Arweave wallet)', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    const protocol = (process.env.ARWEAVE_PROTOCOL || 'https') as 'https' | 'http'
    const client = new ArweaveClient({
      host: process.env.ARWEAVE_HOST || 'arweave.net',
      port: parseInt(process.env.ARWEAVE_PORT ?? '443', 10),
      protocol: (process.env.ARWEAVE_PROTOCOL as 'http' | 'https') || 'https',
    })

    const dataBuffer = Buffer.from(body.data, 'utf-8')
    
    const tags: Record<string, string> = {
      'Content-Type': 'application/json',
      'App-Name': 'AgentVault',
      ...body.tags,
    }
    
    if (body.metadata) {
      tags['X-AgentVault-Metadata'] = JSON.stringify(body.metadata)
    }

    const result = await client.uploadData(dataBuffer, body.jwk, { tags })

    if (!result.success || !result.transactionId) {
      return NextResponse.json(
        { success: false, error: { message: result.error ?? 'Upload failed', code: 'UPLOAD_FAILED' } },
        { status: 502 }
      )
    }

    const response: UploadResponse = {
      txId: result.transactionId,
      url: `https://arweave.net/${result.transactionId}`,
      timestamp: new Date().toISOString(),
      tags,
      size: dataBuffer.length,
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
