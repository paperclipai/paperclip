import { NextResponse } from 'next/server';
import { promoteCanister } from '@/deployment/promotion.js';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { agentName, from, to, targetCanisterId, blueGreen } = body;
    
    if (!agentName || !from || !to) {
      return NextResponse.json({
        success: false,
        error: 'agentName, from, and to environment names are required',
      }, { status: 400 });
    }

    const result = await promoteCanister(agentName, from, to, {
      targetCanisterId,
      blueGreen,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
