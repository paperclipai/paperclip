import { NextResponse } from 'next/server';
import { listNetworkConfigs } from '@/network/network-config.js';

export async function GET() {
  try {
    const networks = await listNetworkConfigs();
    
    return NextResponse.json({
      success: true,
      data: networks,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
