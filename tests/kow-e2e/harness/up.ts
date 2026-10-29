import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  baseImg, newNonce, runDirFor, ensureDirs, freePort,
  waitForSsh, writeManifest, readProcStartTime, type Manifest,
} from "./lib.ts";

export interface GuestCtx {
  nonce: string; runDir: string; port: number; keyPath: string;
  knownHosts: string; overlay: string; consoleLog: string; qemuPid: number;
}

function sh(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? "";
}

export async function up(nonce: string = newNonce()): Promise<GuestCtx> {
  const base = baseImg();
  if (!existsSync(base)) {
    throw new Error(`base image missing: ${base} (run: bun harness/setup-base.ts)`);
  }
  ensureDirs();
  const runDir = runDirFor(nonce);
  mkdirSync(runDir, { recursive: true });
  const keyPath = join(runDir, "id");
  const knownHosts = join(runDir, "known_hosts");
  const overlay = join(runDir, "overlay.qcow2");
  const seed = join(runDir, "seed.iso");
  const consoleLog = join(runDir, "console.log");
  const port = await freePort();

  sh("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
  const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();

  writeFileSync(join(runDir, "user-data"), `#cloud-config
ssh_pwauth: false
users:
  - name: tester
    ssh_authorized_keys:
      - ${pub}
    sudo: 'ALL=(ALL) NOPASSWD:ALL'
    shell: /bin/bash
    lock_passwd: false
runcmd:
  - [ bash, -c, "echo $(date -u +%s) > /run/boot-marker" ]
  - [ bash, -c, "shutdown +30 'pkst dead-man' || true" ]
`);
  writeFileSync(join(runDir, "meta-data"),
    `instance-id: pkst-${nonce}\nlocal-hostname: pkst\n`);
  sh("cloud-localds", [seed, join(runDir, "user-data"), join(runDir, "meta-data")]);
  sh("qemu-img", ["create", "-f", "qcow2", "-F", "qcow2", "-b", base, overlay]);
  sh("qemu-img", ["resize", overlay, "20G"]);

  const bootSh = join(runDir, "boot.sh");
  writeFileSync(bootSh, `#!/bin/bash
cd "${runDir}"
setsid qemu-system-x86_64 -accel kvm -machine q35 -cpu host -m 2048 -smp 2 \\
  -display none -serial file:"${consoleLog}" -monitor none \\
  -drive file="${overlay}",if=virtio \\
  -drive file="${seed}",if=virtio,format=raw \\
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:${port}-:22 \\
  -device virtio-net-pci,netdev=n0 </dev/null >/dev/null 2>&1 &
echo $! > "${join(runDir, "qemu.pid")}"
`, { mode: 0o755 });
  spawnSync("bash", [bootSh], { encoding: "utf8" });
  await new Promise((r) => setTimeout(r, 1500));
  const qemuPid = parseInt(readFileSync(join(runDir, "qemu.pid"), "utf8").trim(), 10);
  const qemuStartTime = readProcStartTime(qemuPid) ?? 0;

  const manifest: Manifest = {
    nonce, qemuPid, qemuStartTime, hostfwdPort: port, overlayPath: overlay, runDir,
    owner: process.env.USER ?? "claude", startedAt: new Date().toISOString(),
  };
  writeManifest(manifest);

  const ok = await waitForSsh(port, keyPath, knownHosts);
  if (!ok) throw new Error(`guest ${nonce} never became SSH-ready (see ${consoleLog})`);

  return { nonce, runDir, port, keyPath, knownHosts, overlay, consoleLog, qemuPid };
}

if (import.meta.main) {
  up().then((c) => {
    console.log(JSON.stringify(
      { ok: true, nonce: c.nonce, port: c.port, runDir: c.runDir, qemuPid: c.qemuPid }, null, 2));
  }).catch((e) => { console.error("up failed:", e.message); process.exit(1); });
}
