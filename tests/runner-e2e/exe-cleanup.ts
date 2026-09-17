import { createHash } from "node:crypto";
import { ssh, quote } from "../../packages/plugins/sandbox-providers/exe-dev/src/transport.js";

/** Destructive fixture cleanup requires the exact company/environment ownership tag. */
export async function cleanupExeFixture(input: {
  vmName: unknown; companyId: string; environmentId: string; sshPrivateKey?: string;
}) {
  if (typeof input.vmName !== "string" || !/^paperclip-e2e-[a-f0-9]{20}$/.test(input.vmName)) {
    throw new Error("Refusing cleanup of a non-campaign VM");
  }
  if (!input.sshPrivateKey) throw new Error("Missing exe.dev cleanup credential");
  const config = { sshPrivateKey: input.sshPrivateKey, strictHostKeyChecking: "accept-new" as const, timeoutMs: 120000 };
  const listing = JSON.parse(await ssh(config, "exe.dev", "ls -l --json"));
  const vm = listing.vms.find((entry: Record<string, unknown>) => entry.vm_name === input.vmName);
  if (!vm) return;
  const tag = "paperclip-" + createHash("sha256").update(`${input.companyId}\0${input.environmentId}`).digest("hex").slice(0, 32);
  if (!vm.tags?.includes(tag)) throw new Error("Refusing deletion: VM ownership tag does not match this fixture");
  await ssh(config, "exe.dev", `rm --json ${quote(input.vmName)}`);
  const remaining = JSON.parse(await ssh(config, "exe.dev", "ls --json"));
  if (remaining.vms.some((entry: Record<string, unknown>) => entry.vm_name === input.vmName)) throw new Error("exe.dev VM cleanup could not be confirmed");
}
