import { Router, type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { oauthConnections } from "@paperclipai/db/schema/oauth";

export interface MarkRevokedDeps {
  // db: Drizzle handle. Kept loose so this route does not pull the full Db
  // type into the module; wired up in app.ts (T28) with the real instance.
  db: any;
}

interface RunJwtClaim {
  connectionIds?: unknown;
  runId?: unknown;
  companyId?: unknown;
}

// The run-JWT middleware attaches `req.runJwt` with the OAuth connection IDs
// scoped to this run plus the issuing company. The field is not on
// Express.Request in this module's TS view — we read it via a local cast and
// tests inject it directly.
export function oauthMarkRevokedRoute(deps: MarkRevokedDeps): RequestHandler {
  const r = Router({ mergeParams: true });
  r.post("/", async (req, res) => {
    const claim = (req as unknown as { runJwt?: RunJwtClaim }).runJwt;
    if (!claim) {
      res.status(401).json({ errorCode: "unauthenticated" });
      return;
    }
    const allowed: string[] = Array.isArray(claim.connectionIds)
      ? claim.connectionIds.filter((x): x is string => typeof x === "string")
      : [];
    const id = (req.params as { id?: string }).id ?? "";
    if (!allowed.includes(id)) {
      res.status(403).json({ errorCode: "forbidden" });
      return;
    }
    const companyId = typeof claim.companyId === "string" ? claim.companyId : "";
    if (!companyId) {
      res.status(401).json({ errorCode: "unauthenticated" });
      return;
    }
    // Defense-in-depth: scope the UPDATE to the JWT's company too. The
    // connectionIds list is the primary boundary, but pinning company_id
    // prevents a stale or crafted JWT containing a connection ID from
    // another tenant from silently mutating a cross-tenant row.
    await deps.db
      .update(oauthConnections)
      .set({
        status: "revoked",
        lastError: "runtime_401",
        lastErrorAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(oauthConnections.id, id),
          eq(oauthConnections.companyId, companyId),
        ),
      );
    res.status(204).end();
  });
  return r;
}
