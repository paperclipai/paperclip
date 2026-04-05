import { Router } from "express";
import type { Db } from "@paperclipai/db";
import Stripe from "stripe";
import { stripeService } from "../services/stripe.js";

export function stripeWebhookRoute(db: Db) {
  const router = Router();

  // Support both URL patterns (Stripe dashboard may use either)
  router.post(["/webhooks/stripe", "/stripe/webhook"], async (req, res) => {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripeSecretKey || !endpointSecret) {
      res.status(400).json({ error: "Stripe not configured" });
      return;
    }

    const sig = req.headers["stripe-signature"] as string;
    if (!sig) {
      res.status(400).json({ error: "Missing signature" });
      return;
    }

    const stripe = new Stripe(stripeSecretKey);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        (req as unknown as { rawBody: Buffer }).rawBody,
        sig,
        endpointSecret,
      );
    } catch {
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    const svc = stripeService(db);
    await svc.handleWebhookEvent(event);
    res.json({ received: true });
  });

  return router;
}
