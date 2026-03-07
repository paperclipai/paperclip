import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { InferenceFallbackChain, type FallbackInferenceRequest, type InferenceProvider } from '@/inference/fallback-chain.js'

interface AVInferRequest {
  prompt: string
  preferredBackend?: InferenceProvider
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

interface AVInferResponse {
  text: string
  backend: InferenceProvider
  latencyMs: number
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  try {
    const body: AVInferRequest = await request.json()
    
    if (!body.prompt) {
      return NextResponse.json(
        { success: false, error: { message: 'Missing required field: prompt', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    const disableProviders: InferenceProvider[] = []
    if (body.preferredBackend) {
      const allProviders: InferenceProvider[] = ['bittensor', 'venice', 'local']
      for (const p of allProviders) {
        if (p !== body.preferredBackend) {
          disableProviders.push(p)
        }
      }
    }

    const chain = new InferenceFallbackChain({
      disableProviders,
      venice: {
        apiKey: process.env.VENICE_API_KEY,
      },
      localModel: {
        endpoint: process.env.LOCAL_MODEL_ENDPOINT || 'http://localhost:11434',
      },
    })

    const inferRequest: FallbackInferenceRequest = {
      prompt: body.prompt,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      systemPrompt: body.systemPrompt,
    }

    const result = await chain.infer(inferRequest)

    if (!result.success || !result.text || !result.provider) {
      return NextResponse.json(
        { 
          success: false, 
          error: { 
            message: result.error ?? 'All inference providers failed',
            code: 'INFERENCE_FAILED',
            details: result.attemptsLog
          } 
        },
        { status: 502 }
      )
    }

    const response: AVInferResponse = {
      text: result.text,
      backend: result.provider,
      latencyMs: result.responseTime ?? 0,
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
