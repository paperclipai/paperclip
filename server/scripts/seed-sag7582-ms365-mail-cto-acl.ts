/**
 * SAG-7582: idempotent one-off provisioning for the CTO-only, read-only Microsoft
 * Graph mail connection.
 *
 * This does NOT touch any secret value. It creates a `local_stdio` tool connection
 * bound to the `paperclip.ms365-mail-readonly` built-in template (fixed args, defined
 * in server/src/services/tool-gateway.ts and tool-access.ts) and installs it for the
 * CTO agent only. The three MS365_MCP_* credentials are resolved at spawn time from
 * the Paperclip server's own process env (see the `localStdioEnvironment` fallback in
 * tool-gateway.ts) — this script never reads, prints, or stores their values.
 *
 * Run once, after this PR is deployed, against the target instance:
 *   DATABASE_URL=... PAPERCLIP_COMPANY_ID=... pnpm --filter @paperclipai/server run \
 *     seed:sag7582-ms365-mail-cto-acl
 *
 * Safe to re-run: it looks up the connection by name before creating it, and
 * `putConnectionInstalls` is a full idempotent replace of the install/binding set.
 *
 * See docs/graph-scope-allowlist-sop.md for the general add/remove SOP this
 * mechanizes.
 */
import { createDb } from "@paperclipai/db";
import { toolAccessService } from "../src/services/tool-access.js";

const TEMPLATE_ID = "paperclip.ms365-mail-readonly";
const CONNECTION_NAME = "Microsoft 365 Mail (read-only, CTO)";
const DEFAULT_CTO_AGENT_ID = "f3c48afc-c339-4e43-b47b-a42a0891229d";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error("PAPERCLIP_COMPANY_ID is required");
  const ctoAgentId = process.env.SAG7582_CTO_AGENT_ID?.trim() || DEFAULT_CTO_AGENT_ID;

  const db = createDb(databaseUrl);
  const svc = toolAccessService(db);

  const existingConnections = await svc.listConnections(companyId);
  let connection = existingConnections.find((row) => row.name === CONNECTION_NAME) ?? null;

  if (!connection) {
    connection = await svc.createConnection(companyId, {
      applicationName: "Microsoft 365 Mail",
      name: CONNECTION_NAME,
      transport: "local_stdio",
      status: "active",
      enabled: true,
      config: { templateId: TEMPLATE_ID },
      credentialSecretRefs: [],
    });
    console.log(`Created connection ${connection.id} (${connection.name})`);
  } else {
    console.log(`Reusing existing connection ${connection.id} (${connection.name})`);
  }

  const refresh = await svc.refreshCatalog(connection.id);
  console.log(`Catalog refreshed: ${refresh.catalog.length} tool(s) from template ${TEMPLATE_ID}`);

  const installSnapshot = await svc.putConnectionInstalls(connection.id, {
    installs: [{ targetType: "agent", targetId: ctoAgentId }],
  });
  console.log(`Installed for agent ${ctoAgentId} only. Install snapshot:`, JSON.stringify(installSnapshot, null, 2));

  console.log("\nDone. Binding key set:");
  console.log(`  connectionId=${connection.id}`);
  console.log(`  profileKey=app:${connection.id}`);
  console.log(`  targetType=agent targetId=${ctoAgentId}`);
  console.log("No other targetType/targetId is present in this connection's installs, so no other agent can reach it.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
