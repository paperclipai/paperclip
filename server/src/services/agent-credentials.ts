import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { collectSecretRefs, collectUserSecretRefs, syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import { logActivity } from "./activity-log.js";
import { claudeOAuthBindingsMatchExactly, claudeOAuthClaimRejectedError,
  CLAUDE_LOCAL_ADAPTER_TYPE, readClaudeOAuthBinding, secretService, type ClaudeOAuthBindingInvariantDecision } from "./secrets.js";
import { createDbSetupTokenCleanupStore } from "./setup-token-session.js";
import type { ClaudeLoginContext, RevisionMetadata } from "../lib/agent-records.js";

export function agentCredentialService(db: Db) {
  const secretsSvc = secretService(db);
  async function syncAgentSecretBindings(
    agent: { id: string; companyId: string; adapterConfig: unknown },
    dbClient: Db = db,
    previousAdapterConfig: unknown = null,
    actor: RevisionMetadata = {},
  ) {
    const scopedSecretsSvc = dbClient === db ? secretsSvc : secretService(dbClient);
    await syncAgentAdapterEnvBindings({
      secretsSvc: scopedSecretsSvc,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterConfig: agent.adapterConfig,
    });
    const previousRefs = new Set([
      ...collectSecretRefs(previousAdapterConfig).map((ref) => `secret:${ref.secretId}:${ref.configPath}`),
      ...collectUserSecretRefs(previousAdapterConfig).map((ref) => `user:${ref.definitionKey}:${ref.configPath}`),
    ]);
    const createdRefs = [
      ...collectSecretRefs(agent.adapterConfig).map((ref) => ({
        key: `secret:${ref.secretId}:${ref.configPath}`,
        configPath: ref.configPath,
        bindingType: "secret_ref",
        secretId: ref.secretId,
        definitionKey: null,
      })),
      ...collectUserSecretRefs(agent.adapterConfig).map((ref) => ({
        key: `user:${ref.definitionKey}:${ref.configPath}`,
        configPath: ref.configPath,
        bindingType: "user_secret_ref",
        secretId: null,
        definitionKey: ref.definitionKey,
      })),
    ].filter((ref) => !previousRefs.has(ref.key));
    const actorType = actor.createdByUserId ? "user" as const : actor.createdByAgentId ? "agent" as const : "system" as const;
    const actorId = actor.createdByUserId ?? actor.createdByAgentId ?? "system";
    for (const ref of createdRefs) {
      await logActivity(dbClient, {
        companyId: agent.companyId,
        actorType,
        actorId,
        agentId: actor.createdByAgentId ?? null,
        action: "secret.binding.created",
        entityType: "agent",
        entityId: agent.id,
        details: {
          targetType: "agent",
          targetId: agent.id,
          configPath: ref.configPath,
          bindingType: ref.bindingType,
          secretId: ref.secretId,
          definitionKey: ref.definitionKey,
        },
      });
    }
  }

  /**
   * Enforces the Claude OAuth binding claim inside a write transaction. It runs
   * after {@link assertClaudeOAuthBindingInvariant} decided that the write
   * introduces or keeps the fixed binding.
   *
   * When the write introduces the fixed binding:
   *   * A create or hire path (`consume: true`) consumes a stored-session claim
   *     with one conditional write. It builds the claim scope from the company,
   *     the owner user, the fixed adapter, the environment, and the
   *     `storedSessionId`. It inserts the binding only when the write returns one
   *     row; otherwise it raises the fixed claim error, which rolls back the
   *     whole transaction and inserts no binding.
   *   * An update, approval, or rollback path (`consume: false`) carries no
   *     claim, so it raises the same fixed claim error at once.
   *
   * The user-actor apply-existing path (`applyExistingWithoutClaim`) binds the
   * fixed reference with no login round trip. The route sets the flag only for
   * an authenticated user actor and derives the owner from that actor. The gate
   * permits the no-claim bind only when the owner already has a stored value for
   * the company. It reads the owner value status; it reads no token. A missing
   * owner or a missing stored value raises the same fixed claim error, so the
   * caller cannot tell the reasons apart.
   *
   * The hire-inheritance path (`inheritedFromAgentId`) binds the fixed
   * reference with no login round trip and no stored owner value, because the
   * owning user resolves per run, not from a value stored against this agent.
   * The route copies the parent's reference onto the child before this
   * transaction starts, so a concurrent version change on the parent can
   * leave the child holding a stale version. The gate re-reads the named
   * parent agent inside this transaction and permits the bind only when the
   * parent exists, is in the same company, is a `claude_local` agent, and its
   * current reference matches the child's copied reference exactly, including
   * the version selector. The gate locks the parent row with `SELECT ...
   * FOR UPDATE` before it reads the reference. The lock blocks a concurrent
   * credential rotation on the same parent row until this transaction
   * commits or rolls back, so the compare-and-bind check stays atomic with
   * the parent's current state. The route derives the parent identifier
   * from the authenticated agent actor, never from the request body, so the
   * gate treats it as a claim to verify, not a trusted value.
   *
   * A controlled internal override skips the claim for a migration or an
   * administrator repair. The function creates the fixed user-secret definition
   * before the caller runs the declaration synchronization, so the synchronized
   * declaration always references an existing definition.
   */
  async function enforceClaudeOAuthBindingClaim(
    txDb: Db,
    input: {
      companyId: string;
      decision: ClaudeOAuthBindingInvariantDecision;
      consume: boolean;
      environmentId: string | null;
      claudeLogin?: ClaudeLoginContext;
      /**
       * The adapter config the write is about to persist. The
       * `inheritedFromAgentId` path reads the child's copied
       * `CLAUDE_CODE_OAUTH_TOKEN` reference from it, to compare against the
       * parent's current reference.
       */
      childAdapterConfig?: unknown;
    },
  ): Promise<void> {
    const ownerUserId = input.claudeLogin?.ownerUserId ?? null;
    if (input.decision.introducesBinding && !input.claudeLogin?.allowInternalBindingOverride) {
      if (input.claudeLogin?.applyExistingWithoutClaim) {
        // The user-actor apply-existing path. The route derived the owner from
        // the authenticated user actor. The gate binds the fixed reference only
        // when that owner already has a stored value. It reads no token.
        if (!ownerUserId) {
          throw claudeOAuthClaimRejectedError();
        }
        const stored = await secretService(txDb).readClaudeOAuthUserSecretStatus(
          input.companyId,
          ownerUserId,
        );
        if (!stored) {
          throw claudeOAuthClaimRejectedError();
        }
      } else if (input.claudeLogin?.inheritedFromAgentId) {
        // The hire-inheritance path. Re-read the named parent inside this
        // transaction; a caller-supplied identifier never binds on its own.
        // Compare the parent's current reference against the reference
        // already copied onto the child, including the version selector, so
        // a concurrent version change on the parent cannot leave the child
        // bound to a stale version.
        const parentId = input.claudeLogin.inheritedFromAgentId;
        const parent = await txDb
          .select({
            companyId: agents.companyId,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
          })
          .from(agents)
          .where(eq(agents.id, parentId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const parentBinding = readClaudeOAuthBinding(parent?.adapterConfig ?? null);
        const childBinding = readClaudeOAuthBinding(input.childAdapterConfig ?? null);
        if (
          !parent ||
          parent.companyId !== input.companyId ||
          parent.adapterType !== CLAUDE_LOCAL_ADAPTER_TYPE ||
          !claudeOAuthBindingsMatchExactly(parentBinding, childBinding)
        ) {
          throw claudeOAuthClaimRejectedError();
        }
      } else if (!input.consume) {
        throw claudeOAuthClaimRejectedError();
      } else {
        const consumed = await createDbSetupTokenCleanupStore(txDb).consumeStoredClaim({
          sessionId: input.claudeLogin?.storedSessionId ?? "",
          companyId: input.companyId,
          ownerUserId: ownerUserId ?? "",
          adapterType: CLAUDE_LOCAL_ADAPTER_TYPE,
        });
        if (!consumed) {
          throw claudeOAuthClaimRejectedError();
        }
      }
    }
    if (input.decision.introducesBinding || input.decision.keepsBinding) {
      // Create the fixed definition before declaration synchronization.
      await secretService(txDb).ensureClaudeOAuthUserSecretDefinition(input.companyId, {
        userId: ownerUserId,
      });
    }
  }

  return { syncAgentSecretBindings, enforceClaudeOAuthBindingClaim };
}
