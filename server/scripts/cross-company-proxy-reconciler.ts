import { createDb } from "@paperclipai/db";
import { reconcileCrossCompanyProxyIssues } from "../src/services/cross-company-proxy-reconciler.js";

const DEFAULT_DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

function parseArgs(argv: string[]) {
  const parsed = {
    apply: false,
    companyId: null as string | null,
    failOnDuplicates: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--company-id") parsed.companyId = argv[++i] ?? null;
    else if (arg === "--fail-on-duplicates") parsed.failOnDuplicates = true;
    else if (arg === "--help") {
      console.log("Usage: tsx server/scripts/cross-company-proxy-reconciler.ts [--apply] [--company-id <uuid>] [--fail-on-duplicates]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;

  const db = createDb(databaseUrl);
  const summary = await reconcileCrossCompanyProxyIssues(db, {
    companyId: args.companyId,
    apply: args.apply,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (args.failOnDuplicates && summary.duplicateParentCount > 0) {
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(2);
});
