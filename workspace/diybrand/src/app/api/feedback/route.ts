import { NextRequest, NextResponse } from 'next/server';

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

    // TODO: Implement persistent storage
    // Options:
    // 1. Database (PostgreSQL recommended)
    //    - Save to `feedback` table
    //    - Fields: id, rating, feedback, timestamp, userAgent, referrer
    // 2. File storage (for MVP)
    //    - Write to /tmp or cloud storage
    // 3. Analytics service (Posthog, Mixpanel, etc.)
    //    - Send event with rating and feedback
    // 4. Email service
    //    - Send summary daily to support@diybrand.app

    // For now, log to console (visible in server logs)
    console.log('[FEEDBACK]', JSON.stringify(feedbackData, null, 2));

    // Send success response
    return NextResponse.json(
      {
        success: true,
        message: 'Thank you for your feedback!',
        feedbackId: `fb_${Date.now()}`,
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
 * Retrieve feedback analytics (if authenticated)
 *
 * NOTE: Implement authentication before exposing this in production
 */
export async function GET(request: NextRequest) {
  // TODO: Add authentication check (API key or session)
  // For now, return 403 to prevent unauthorized access

  return NextResponse.json(
    { error: 'Not implemented' },
    { status: 403 }
  );
}
