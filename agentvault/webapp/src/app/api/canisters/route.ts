import { NextResponse } from 'next/server';
import { canisterList } from '@/icp/icpcli.js';

export async function GET() {
  try {
    const result = await canisterList({});
    
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
