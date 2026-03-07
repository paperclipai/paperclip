import { NextResponse } from 'next/server';
import { getSummary, getTimeSeries } from '@/metrics/index.js';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const metric = url.searchParams.get('metric') || 'cycles_balance';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    
    if (!from || !to) {
      return NextResponse.json({
        success: false,
        error: 'from and to query params are required',
      }, { status: 400 });
    }
    
    const series = getTimeSeries(id, metric as any, new Date(from), new Date(to));
    
    return NextResponse.json({
      success: true,
      data: series,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
