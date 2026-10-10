import type { Request, Response } from "express";
import type { z } from "zod";

/**
 * The result of the shared adapter login start-route spine. The spine returns it
 * when every guard passes. `ownerUserId` is the immutable session owner from the
 * actor. `data` is the validated request body.
 */
export interface AdapterLoginStartResolution<TData> {
  ownerUserId: string;
  data: TData;
}

/**
 * The injected steps of the shared adapter login start-route spine. The Codex
 * device login start route and the Claude setup-token login start route both
 * provide them. Each step holds the per-flow rule; the spine holds the shared
 * order.
 */
export interface AdapterLoginStartSpineInput<TData extends { environmentId: string }> {
  req: Request;
  res: Response;
  /**
   * Derives the immutable session owner from the actor. It also runs the company
   * access check. It throws a mapped HTTP error for a forbidden actor. The shared
   * error handler maps the thrown error to the response.
   */
  deriveOwner: () => Promise<string> | string;
  /**
   * The strict request schema. `.strict()` rejects an unknown field. The spine
   * validates the request body against it before any session or lease side
   * effect.
   */
  requestSchema: z.ZodType<TData>;
  /** The fixed 400 text for an invalid request. Each route keeps its own text. */
  invalidRequestError: string;
  /**
   * Merges these fields into the request body before the parse. The Codex route
   * injects the adapter type from the path, so the client body needs no adapter
   * type field.
   */
  requestOverrides?: Record<string, unknown>;
  /**
   * Runs an optional per-flow guard after the owner derivation and before the
   * request validation. The Codex route checks the path adapter type here. It
   * throws a mapped HTTP error to reject the request.
   */
  guardBeforeValidate?: () => void | Promise<void>;
  /**
   * Runs an optional per-flow guard after the validation and before the sandbox
   * check. The Claude route checks the body adapter type and the transport
   * readiness here. It returns `true` when it sends a response; the spine then
   * stops and returns null.
   */
  guardAfterValidate?: (data: TData) => boolean | Promise<boolean>;
  /**
   * Checks the sandbox environment. It throws a mapped HTTP error for a missing,
   * archived, non-sandbox, or foreign environment.
   */
  assertSandbox: (data: TData) => Promise<void>;
}

/**
 * Runs the shared start-route spine for an adapter login. It runs the same
 * ordered steps for both start routes, and it runs every step before any session
 * or lease side effect:
 *
 * 1. It derives the session owner and runs the company access check.
 * 2. It runs the optional pre-validation guard.
 * 3. It validates the request body with the strict schema. It sends the fixed
 *    400 and returns null on a failure.
 * 4. It runs the optional post-validation guard. It returns null when the guard
 *    sends a response.
 * 5. It checks the sandbox environment.
 *
 * It returns the owner and the validated body when every step passes. It returns
 * null when a step sends a response; the caller must then stop.
 */
export async function runAdapterLoginStartSpine<TData extends { environmentId: string }>(
  input: AdapterLoginStartSpineInput<TData>,
): Promise<AdapterLoginStartResolution<TData> | null> {
  const ownerUserId = await input.deriveOwner();

  if (input.guardBeforeValidate) {
    await input.guardBeforeValidate();
  }

  const body =
    input.req.body && typeof input.req.body === "object"
      ? (input.req.body as Record<string, unknown>)
      : {};
  const candidate = input.requestOverrides ? { ...body, ...input.requestOverrides } : body;
  const parsed = input.requestSchema.safeParse(candidate);
  if (!parsed.success) {
    input.res.status(400).json({ error: input.invalidRequestError });
    return null;
  }
  const data = parsed.data;

  if (input.guardAfterValidate) {
    const stop = await input.guardAfterValidate(data);
    if (stop) return null;
  }

  await input.assertSandbox(data);
  return { ownerUserId, data };
}
