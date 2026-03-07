import { NextRequest, NextResponse } from 'next/server'
import type { ShareProofResult } from '@/lib/types'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    // Generate a time-limited share token (in production this would be signed by the canister)
    const token = Buffer.from(
      JSON.stringify({ vaultId: params.id, iat: Date.now(), exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })
    ).toString('base64url')

    const host = request.headers.get('host') ?? 'localhost:3000'
    const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http'

    const result: ShareProofResult = {
      shareUrl: `${proto}://${host}/vault/${params.id}/proof?share=${token}`,
      shareToken: token,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }

    return NextResponse.json({ success: true, data: result })
  } catch (_error) {
    return NextResponse.json(
      { success: false, error: { message: 'Failed to generate share link' } },
      { status: 500 }
    )
  }
}
