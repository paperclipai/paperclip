import { eq, sql } from "drizzle-orm";
import { authUsers, instanceUserRoles, type Db } from "@paperclipai/db";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import type { Config } from "../config.js";
import { readDeploymentCredential } from "./credentials.js";

export interface BootstrapOperatorInput {
  email: string;
  name: string;
  passwordFile: string;
}

/** Process-local bootstrap. Invoke before listeners or dispatch under the lease.
 * Account creation and the first-admin claim commit or roll back together. */
export async function bootstrapOperator(db: Db, config: Config, input?: BootstrapOperatorInput, apply = true) {
  if (!input) return null;
  return db.transaction(async (tx) => {
    if (apply) await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
    // Better Auth normalizes email addresses when it creates the account.
    const email = input.email.trim().toLowerCase();
    const [existing] = await tx.select().from(authUsers).where(eq(authUsers.email, email));
    const admins = await tx.select().from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
    if (existing) {
      if (!admins.some((admin) => admin.userId === existing.id)) {
        throw new Error("Bootstrap refuses to adopt an existing non-administrator account");
      }
      return existing.id;
    }
    if (admins.length) throw new Error("Bootstrap refuses to replace an existing administrator");
    const password = readDeploymentCredential(input.passwordFile).trimEnd();
    if (password.length < 12) throw new Error("Bootstrap password must contain at least 12 characters");
    if (!apply) return null;
    // These APIs only use Drizzle query/transaction methods, not the pool client.
    const transactionDb = tx as unknown as Db;
    const auth = createBetterAuthInstance(transactionDb, { ...config, authDisableSignUp: false }, [], { autoSignIn: false });
    const base = config.authPublicBaseUrl ?? "http://localhost:3100";
    const response = await auth.handler(new Request(new URL("/api/auth/sign-up/email", base), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: input.name, password }),
    }));
    if (!response.ok) throw new Error("Local operator bootstrap failed");
    const [created] = await tx.select().from(authUsers).where(eq(authUsers.email, email));
    if (!created) throw new Error("Local operator bootstrap did not create an account");
    const claim = await claimFirstInstanceAdmin(transactionDb, { userId: created.id });
    if (claim.status !== "claimed") throw new Error("Administrator changed during bootstrap");
    return created.id;
  });
}
