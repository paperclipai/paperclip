import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { withTiming, measureAsync, jsonWithTimings } from "@/lib/timing";

export const GET = withTiming(async (req: NextRequest) => {
  const sessionId = req.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing session_id" },
      { status: 400 }
    );
  }

  let dbTime = 0;
  let stripeTime = 0;

  // Check if we already have the order recorded (via webhook)
  const [[existing], dbCheckTime] = await measureAsync(() =>
    db
      .select()
      .from(orders)
      .where(eq(orders.stripeSessionId, sessionId))
      .limit(1)
  );
  dbTime += dbCheckTime;

  if (existing) {
    return jsonWithTimings(
      {
        paid: true,
        tier: existing.tier,
        questionnaireId: existing.questionnaireId,
      },
      {
        timings: [
          { name: "db", duration: dbTime, description: "Database check" },
        ],
      }
    );
  }

  // Webhook may not have fired yet — verify directly with Stripe
  try {
    const [session, retrieveTime] = await measureAsync(() =>
      getStripe().checkout.sessions.retrieve(sessionId)
    );
    stripeTime += retrieveTime;

    if (session.payment_status === "paid" && session.metadata) {
      const { questionnaireId, tier } = session.metadata;
      if (questionnaireId && tier && session.customer_details?.email) {
        // Record the order since webhook hasn't processed it yet
        const [, insertTime] = await measureAsync(() =>
          db
            .insert(orders)
            .values({
              email: session.customer_details.email,
              stripeSessionId: session.id,
              tier,
              questionnaireId,
              paidAt: new Date(),
            })
            .onConflictDoNothing()
        );
        dbTime += insertTime;

        return jsonWithTimings(
          {
            paid: true,
            tier,
            questionnaireId,
          },
          {
            timings: [
              { name: "db", duration: dbTime, description: "Database queries" },
              { name: "stripe", duration: stripeTime, description: "Stripe verification" },
            ],
          }
        );
      }
    }

    return jsonWithTimings(
      { paid: false },
      {
        timings: [
          { name: "db", duration: dbTime, description: "Database check" },
          { name: "stripe", duration: stripeTime, description: "Stripe verification" },
        ],
      }
    );
  } catch {
    return NextResponse.json({ paid: false });
  }
});
