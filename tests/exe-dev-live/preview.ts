/** Interactive private Vite acceptance fixture. Always finish with cleanup. */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import plugin from "../../packages/plugins/sandbox-providers/exe-dev/src/plugin.js";
import { ssh, quote } from "../../packages/plugins/sandbox-providers/exe-dev/src/transport.js";
import type { PluginEnvironmentLease } from "../../packages/plugins/sdk/src/protocol.js";

if (process.env.EXE_DEV_LIVE_SMOKE !== "1") throw new Error("EXE_DEV_LIVE_SMOKE=1 required");
const statePath = process.env.EXE_DEV_PREVIEW_STATE ?? "/tmp/paperclip-exe-preview.json";
const action = process.argv[2] ?? "create";
const hooks = plugin.definition;
const sshConfig = { sshPrivateKey: process.env.EXE_DEV_SSH_PRIVATE_KEY, strictHostKeyChecking: "accept-new" as const, timeoutMs: 300000 };
type State = { companyId: string; environmentId: string; vmName: string; image: string; lease: PluginEnvironmentLease; createdAt: string };
let state: State;
if (action === "create") {
  const image = process.env.PAPERCLIP_E2E_EXE_IMAGE;
  if (!image) throw new Error("PAPERCLIP_E2E_EXE_IMAGE required");
  state = { companyId: randomUUID(), environmentId: randomUUID(), vmName: `paperclip-preview-${randomUUID().slice(0, 12)}`, image, lease: { providerLeaseId: null }, createdAt: new Date().toISOString() };
  // Record the owned name before provisioning, including partial failures.
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
} else state = JSON.parse(await readFile(statePath, "utf8"));
if (!/^paperclip-preview-[a-f0-9-]{12}$/.test(state.vmName)) throw new Error("Not an owned preview fixture");
const config = { ...sshConfig, mode: "create", vmName: state.vmName, image: state.image, reuseLease: true };
const scope = { companyId: state.companyId, environmentId: state.environmentId, driverKey: "exe-dev", config };
const host = `${state.vmName}.exe.xyz`;
const run = (script: string) => ssh(sshConfig, host, script);
try {
  if (action === "create") {
    state.lease = await hooks.onEnvironmentAcquireLease!({ ...scope, agentId: "vite-preview", runId: randomUUID() });
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    const cwd = String(state.lease.metadata?.remoteCwd);
    const files = {
      "package.json": JSON.stringify({ private: true, type: "module", dependencies: { vite: "8.2.2" } }),
      "index.html": '<!doctype html><html><head><title>Paperclip exe.dev preview</title></head><body><h1>Durable Vite preview</h1><p id="status"></p><script type="module" src="/main.js"></script></body></html>',
      "main.js": "document.querySelector('#status').textContent='Version 1 — live on exe.dev'; if(import.meta.hot) import.meta.hot.accept();",
      "vite.config.js": `export default {server:{host:'0.0.0.0',port:8000,strictPort:true,allowedHosts:[${JSON.stringify(host)}]}};`,
    };
    const write = `const fs=require('fs');for(const [name,body] of Object.entries(${JSON.stringify(files)}))fs.writeFileSync(${JSON.stringify(cwd)}+'/'+name,body);`;
    await run(`node -e ${quote(write)} && cd ${quote(cwd)} && npm install --ignore-scripts --no-audit --no-fund`);
    const unit = `[Unit]\nDescription=Paperclip exe.dev Vite acceptance fixture\nAfter=network.target\n[Service]\nUser=exedev\nWorkingDirectory=${cwd}\nExecStart=/usr/local/bin/node ${cwd}/node_modules/vite/bin/vite.js\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n`;
    await run(`printf %s ${quote(unit)} | sudo -n tee /etc/systemd/system/paperclip-vite-preview.service >/dev/null && sudo -n systemctl daemon-reload && sudo -n systemctl enable --now paperclip-vite-preview.service`);
  } else if (action === "cancel") {
    await hooks.onEnvironmentDestroyLease!({ ...scope, providerLeaseId: state.lease.providerLeaseId, leaseMetadata: state.lease.metadata });
  } else if (action === "edit") {
    await run(`printf %s ${quote("document.querySelector('#status').textContent='Version 2 — HMR after agent cancellation'; if(import.meta.hot) import.meta.hot.accept();")} > ${quote(String(state.lease.metadata?.remoteCwd) + "/main.js")}`);
  } else if (action === "cleanup") {
    await ssh(sshConfig, "exe.dev", `rm --json ${quote(state.vmName)}`);
  } else throw new Error("Use create, cancel, edit, or cleanup");
  console.log(JSON.stringify({ action, url: `https://${host}`, statePath, createdAt: state.createdAt }));
} finally { await hooks.onShutdown?.(); }
