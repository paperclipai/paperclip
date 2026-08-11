import {
  remediateManagedCodexHomePermissions,
} from "../packages/adapters/codex-local/src/server/codex-home.js";

function readFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : null;
  return value && !value.startsWith("--") ? value : null;
}

const args = process.argv.slice(2);
const companyId = readFlagValue(args, "--company-id");
if (!companyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId)) {
  throw new Error("Usage: --company-id <id> [--apply --post-drain-confirmed]");
}

const apply = args.includes("--apply");
const postDrainConfirmed = args.includes("--post-drain-confirmed");
const changes = await remediateManagedCodexHomePermissions(process.env, companyId, {
  apply,
  postDrainConfirmed,
});

console.log(`${apply ? "Applied" : "Dry-run found"} ${changes.length} permission change(s) in the managed Codex home.`);
for (const change of changes) {
  console.log(
    `${apply ? "changed" : "would change"} ${change.path}: ${change.currentMode.toString(8)} -> ${change.requiredMode.toString(8)}`,
  );
}
