/**
 * Self-serve signup flow: POST /api/setup
 *
 * After a customer completes Polar checkout, they land on /setup?checkout_id=xxx.
 * The frontend calls this endpoint to:
 *   1. Verify the checkout with Polar
 *   2. Create the user account via Better Auth's internal tables
 *   3. Create the company + subscription + seed defaults
 *   4. Return a session so the user is auto-logged in
 *
 * Also: POST /api/checkout/create — public endpoint for the landing page to
 * create a Polar checkout session without requiring auth.
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import {
  authUsers,
  authAccounts,
  authSessions,
  companySubscriptions,
  instanceUserRoles,
} from "@ironworksai/db";
import {
  companyService,
  accessService,
  playbookService,
  routineService,
  billingService,
  PLAN_DEFINITIONS,
  type PlanTier,
} from "../services/index.js";
import { knowledgeService } from "../services/knowledge.js";
import { logActivity } from "../services/activity-log.js";
import { badRequest, conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Polar API helper (reuse the same pattern from billing service)
// ---------------------------------------------------------------------------

const POLAR_API_BASE = "https://api.polar.sh/v1";

function getPolarToken(): string {
  const token = process.env.POLAR_ACCESS_TOKEN;
  if (!token) throw new Error("POLAR_ACCESS_TOKEN is not configured");
  return token;
}

async function polarFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getPolarToken();
  const url = `${POLAR_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Polar API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Checkout verification types
// ---------------------------------------------------------------------------

interface PolarCheckout {
  id: string;
  status: string;
  customer_email?: string | null;
  customer_name?: string | null;
  product_id?: string;
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Map Polar product ID to plan tier (mirrors billing service logic)
// ---------------------------------------------------------------------------

function productIdToTier(productId: string): PlanTier {
  for (const [tier, def] of Object.entries(PLAN_DEFINITIONS)) {
    if (def.productId && def.productId === productId) {
      return tier as PlanTier;
    }
  }
  return "starter";
}

// ---------------------------------------------------------------------------
// Password hashing (using scrypt, matching Better Auth's credential format)
// ---------------------------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const { scrypt, randomBytes } = await import("node:crypto");
  const { promisify } = await import("node:util");
  const scryptAsync = promisify(scrypt);
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, simple per-IP)
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// Track consumed checkouts to prevent replay
// ---------------------------------------------------------------------------

const consumedCheckouts = new Set<string>();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const setupSchema = z.object({
  checkoutId: z.string().min(1, "checkoutId is required"),
  companyName: z.string().min(1, "Company name is required").max(100).transform((s) => s.trim()),
  userName: z.string().min(1, "Name is required").max(100).transform((s) => s.trim()),
  email: z.string().email("Invalid email address").transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters"),
  tosAccepted: z.literal(true, {
    errorMap: () => ({ message: "You must accept the Terms of Service and Acceptable Use Policy" }),
  }),
});

const checkoutCreateSchema = z.object({
  tier: z.enum(["starter", "growth", "business"]),
  successUrl: z.string().url("successUrl must be a valid URL"),
  cancelUrl: z.string().url("cancelUrl must be a valid URL"),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function setupRoutes(db: Db) {
  const router = Router();
  const companySvc = companyService(db);
  const access = accessService(db);
  const playbookSvc = playbookService(db);
  const routineSvc = routineService(db);
  const knowledgeSvc = knowledgeService(db);
  const billingSvc = billingService(db);

  // ── POST /api/setup ──────────────────────────────────────────────────
  router.post("/setup", async (req, res) => {
    // Rate limit
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }

    // Validate body
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]?.message ?? "Validation failed";
      throw badRequest(firstError, parsed.error.issues);
    }
    const { checkoutId, companyName, userName, email, password, tosAccepted } = parsed.data;
    void tosAccepted; // validated via z.literal(true)

    // SEC-LOGIC-001: Atomic check-and-claim to prevent race condition.
    // Mark the checkout as consumed BEFORE async work. If provisioning
    // fails, we leave it claimed (user retries with a new checkout).
    if (consumedCheckouts.has(checkoutId)) {
      throw conflict("This checkout has already been used to create an account.");
    }
    consumedCheckouts.add(checkoutId);

    // 1. Verify checkout with Polar
    let checkout: PolarCheckout;
    try {
      checkout = await polarFetch<PolarCheckout>(`/checkouts/custom/${checkoutId}`);
    } catch (err) {
      logger.error({ err, checkoutId }, "Failed to verify Polar checkout");
      throw badRequest("Could not verify payment. Please contact support if the issue persists.");
    }

    if (checkout.status !== "succeeded" && checkout.status !== "confirmed") {
      throw badRequest(
        `Payment has not been completed (status: ${checkout.status}). Please complete checkout first.`,
      );
    }

    // SEC-ADV-012: Verify the submitted email matches the checkout email
    // to prevent checkout ID hijacking (someone using another person's payment)
    if (checkout.customer_email && checkout.customer_email.toLowerCase() !== email) {
      consumedCheckouts.delete(checkoutId); // release the claim
      throw badRequest("Email does not match the checkout. Use the email you paid with.");
    }

    // 2. Determine plan tier from product_id
    const planTier: PlanTier = checkout.product_id
      ? productIdToTier(checkout.product_id)
      : "starter";

    // 3. Check email uniqueness
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);

    if (existingUser) {
      throw conflict("An account with this email already exists. Please sign in instead.");
    }

    // 4. Create user in Better Auth tables
    const userId = randomUUID();
    const now = new Date();
    const passwordHash = await hashPassword(password);

    await db.insert(authUsers).values({
      id: userId,
      name: userName,
      email,
      emailVerified: true, // Payment-verified email
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    // Create credential account for email+password login
    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      createdAt: now,
      updatedAt: now,
    });

    // 5. Grant instance admin (first user on their company is the admin)
    await db.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });

    // 6. Create company
    const company = await companySvc.create({ name: companyName });

    // 7. Set user as company owner
    await access.ensureMembership(company.id, "user", userId, "owner", "active");

    // 8. Create subscription record linking company to Polar
    const polarCustomerId =
      (checkout.metadata?.polarCustomerId as string | undefined) ?? null;

    await billingSvc.getOrCreateSubscription(company.id);
    await db
      .update(companySubscriptions)
      .set({
        polarCustomerId,
        planTier,
        status: "active",
        currentPeriodStart: now,
        updatedAt: now,
      })
      .where(eq(companySubscriptions.companyId, company.id));

    // 9. Seed defaults (non-fatal)
    try {
      await playbookSvc.seedDefaults(company.id);
      await routineSvc.seedDefaults(company.id);
      await knowledgeSvc.seedDefaults(company.id);
    } catch (err) {
      logger.warn({ err, companyId: company.id }, "Non-fatal: seeding defaults failed during setup");
    }

    // 10. Log activity
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: userId,
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: companyName, source: "self-serve-signup", planTier },
    });

    // 11. Create session so frontend auto-logs in
    const sessionToken = randomUUID();
    const sessionId = randomUUID();
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.insert(authSessions).values({
      id: sessionId,
      token: sessionToken,
      userId,
      expiresAt: sessionExpiry,
      ipAddress: clientIp,
      userAgent: req.headers["user-agent"] ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // (checkoutId already claimed at top of handler — SEC-LOGIC-001)

    // Set session cookie (same approach as Better Auth)
    res.cookie("better-auth.session_token", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    logger.info(
      { userId, companyId: company.id, planTier, checkoutId },
      "Self-serve signup completed",
    );

    res.status(201).json({
      companyId: company.id,
      userId,
      redirectUrl: "/dashboard",
    });
  });

  // ── POST /api/checkout/create ────────────────────────────────────────
  // Public endpoint — no auth required. The landing page calls this
  // to get a Polar checkout URL for the selected tier.
  router.post("/checkout/create", async (req, res) => {
    const parsed = checkoutCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]?.message ?? "Validation failed";
      throw badRequest(firstError, parsed.error.issues);
    }
    const { tier, successUrl, cancelUrl } = parsed.data;

    const plan = PLAN_DEFINITIONS[tier];
    if (!plan.productId) {
      throw badRequest(`No Polar product configured for tier: ${tier}`);
    }

    const checkout = await polarFetch<{ url: string; id: string }>(
      "/checkouts/custom",
      {
        method: "POST",
        body: JSON.stringify({
          product_id: plan.productId,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: { planTier: tier, source: "self-serve" },
        }),
      },
    );

    if (!checkout.url) {
      throw new Error("Polar did not return a checkout URL");
    }

    res.json({ checkoutUrl: checkout.url, checkoutId: checkout.id });
  });

  return router;
}
