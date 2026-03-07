import { NextResponse } from 'next/server';
import { canisterStatus } from '@/icp/icpcli.js';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params;
    const result = await canisterStatus({
      canister: id,
    });

    return NextResponse.json({
      success: true,
      data: result.stdout,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
