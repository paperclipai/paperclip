import { NextRequest, NextResponse } from "next/server";
import { getStripe, TIERS, Tier } from "@/lib/stripe";
import { withTiming, measureAsync, jsonWithTimings } from "@/lib/timing";

export const POST = withTiming(async (req: NextRequest) => {
  const body = await req.json();
  const { questionnaireId, tier } = body as {
    questionnaireId: string;
    tier: string;
  };

  if (!questionnaireId || !tier || !(tier in TIERS)) {
    return NextResponse.json(
      { error: "Missing questionnaireId or invalid tier" },
      { status: 400 }
    );
  }

  const tierConfig = TIERS[tier as Tier];
  const origin = req.headers.get("origin") || "http://localhost:3000";

  const [session, stripeTime] = await measureAsync(() =>
    getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: tierConfig.name,
              description: tierConfig.description,
            },
            unit_amount: tierConfig.price,
          },
          quantity: 1,
        },
      ],
      metadata: {
        questionnaireId,
        tier,
      },
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/questionnaire?cancelled=true`,
    })
  );

  return jsonWithTimings(
    { url: session.url },
    {
      timings: [
        { name: "stripe", duration: stripeTime, description: "Stripe session creation" },
      ],
    }
  );
});
