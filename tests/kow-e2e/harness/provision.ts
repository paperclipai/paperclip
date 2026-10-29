import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { up, type GuestCtx } from "./up.ts";
import { scpBase, ssh, newNonce } from "./lib.ts";

const ASSET_DIR = "/home/tester/pkst-assets";
const RUNROOT = "/opt/pkst";

export interface ProvisionCtx extends GuestCtx {
  placeholder: string;
  runRoot: string;
  assetDir: string;
}

function newPlaceholder(): string {
  return "pkPLACEHOLDER" + randomBytes(10).toString("hex");
}

function scpDir(ctx: GuestCtx, localDir: string, remoteParent: string) {
  const r = spawnSync("scp", [
    ...scpBase(ctx.port, ctx.keyPath, ctx.knownHosts), "-r", localDir, `tester@127.0.0.1:${remoteParent}`,
  ], { encoding: "utf8", timeout: 120_000 });
  if ((r.status ?? -1) !== 0) throw new Error(`scp -r failed: ${r.stderr || r.stdout}`);
}

function run(ctx: GuestCtx, cmd: string, label: string): string {
  const r = ssh(ctx.port, ctx.keyPath, ctx.knownHosts, "tester", cmd);
  process.stdout.write(`\n=== ${label} (rc=${r.code}) ===\n${r.stdout}\n${r.stderr ? "STDERR:\n" + r.stderr : ""}`);
  if (r.code !== 0) throw new Error(`${label} failed rc=${r.code}`);
  return r.stdout;
}

export async function provision(nonce: string = newNonce()): Promise<ProvisionCtx> {
  const guest = await up(nonce);
  const placeholder = newPlaceholder();
  const here = new URL("../guest", import.meta.url).pathname;

  scpDir(guest, here, "/home/tester/");
  run(guest, `mv /home/tester/guest ${ASSET_DIR} 2>/dev/null || true; chmod +x ${ASSET_DIR}/*.sh; ls ${ASSET_DIR}`, "push assets");

  run(guest, `bash ${ASSET_DIR}/provision.sh ${guest.nonce} ${placeholder} ${RUNROOT}`, "provision.sh");
  run(guest, `bash ${ASSET_DIR}/start.sh ${placeholder} ${RUNROOT}`, "start.sh");

  return { ...guest, placeholder, runRoot: RUNROOT, assetDir: ASSET_DIR };
}

if (import.meta.main) {
  provision().then((c) => {
    console.log(JSON.stringify(
      { ok: true, nonce: c.nonce, port: c.port, runDir: c.runDir, placeholder: c.placeholder }, null, 2));
  }).catch((e) => { console.error("provision failed:", e.message); process.exit(1); });
}
