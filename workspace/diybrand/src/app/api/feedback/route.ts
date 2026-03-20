import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { feedback as feedbackTable } from '@/db/schema';

interface FeedbackData {
  rating: number;
  feedback: string;
  timestamp: string;
  userAgent?: string;
  referrer?: string;
}

/**
 * POST /api/feedback
 * Collects customer feedback and NPS data
 *
 * Expected body:
 * {
 *   rating: 1-5,
 *   feedback: string,
 *   timestamp: ISO string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as FeedbackData;

    // Validate input
    if (!body.rating || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
      return NextResponse.json(
        { error: 'Rating must be an integer between 1 and 5' },
        { status: 400 }
      );
    }

    if (typeof body.feedback !== 'string' || body.feedback.length > 1000) {
      return NextResponse.json(
        { error: 'Feedback must be a string with max 1000 characters' },
        { status: 400 }
      );
    }

    // Prepare feedback data
    const feedbackData: FeedbackData = {
      rating: body.rating,
      feedback: body.feedback.trim(),
      timestamp: body.timestamp || new Date().toISOString(),
      userAgent: request.headers.get('user-agent') || undefined,
      referrer: request.headers.get('referer') || undefined,
    };

    // Save feedback to database
    const result = await db.insert(feedbackTable).values({
      rating: feedbackData.rating,
      text: feedbackData.feedback.trim() || null,
      userAgent: feedbackData.userAgent,
      referrer: feedbackData.referrer,
    }).returning({ id: feedbackTable.id });

    const feedbackId = result[0]?.id || `fb_${Date.now()}`;

    // Log for visibility in server logs
    console.log('[FEEDBACK SAVED]', { feedbackId, rating: feedbackData.rating, feedback: feedbackData.feedback });

    // Send success response
    return NextResponse.json(
      {
        success: true,
        message: 'Thank you for your feedback!',
        feedbackId,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[FEEDBACK ERROR]', error);

    return NextResponse.json(
      { error: 'Failed to submit feedback' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/feedback
 * Retrieve feedback analytics (requires API key)
 *
 * Query params:
 * - apiKey: secret key for authentication (required)
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.nextUrl.searchParams.get('apiKey');
    const expectedKey = process.env.FEEDBACK_API_KEY;

    // Require authentication
    if (!expectedKey || !apiKey || apiKey !== expectedKey) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get feedback analytics
    const allFeedback = await db.query.feedback.findMany();

    const stats = {
      total: allFeedback.length,
      averageRating: allFeedback.length > 0
        ? (allFeedback.reduce((sum, f) => sum + f.rating, 0) / allFeedback.length).toFixed(2)
        : 0,
      ratingDistribution: {
        5: allFeedback.filter(f => f.rating === 5).length,
        4: allFeedback.filter(f => f.rating === 4).length,
        3: allFeedback.filter(f => f.rating === 3).length,
        2: allFeedback.filter(f => f.rating === 2).length,
        1: allFeedback.filter(f => f.rating === 1).length,
      },
      recentFeedback: allFeedback
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10)
        .map(f => ({
          id: f.id,
          rating: f.rating,
          text: f.text,
          createdAt: f.createdAt,
        })),
    };

    return NextResponse.json(stats, { status: 200 });
  } catch (error) {
    console.error('[FEEDBACK GET ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to retrieve feedback' },
      { status: 500 }
    );
  }
}
