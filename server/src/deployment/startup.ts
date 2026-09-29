import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import { loadDeploymentDescriptor, readJson } from "./runtime.js";

export async function reconcileDeploymentOnStartup(db: Db, config: Config) {
  const file = process.env.PAPERCLIP_DEPLOYMENT_FILE;
  if (!file) return;
  const { reconcileDeployment } = await import("./reconcile.js");
  const descriptor = loadDeploymentDescriptor(file);
  const manifest = descriptor.manifestFile ? readJson(descriptor.manifestFile)
    : { version: 1, owner: descriptor.instance, companies: {} };
  const result = await reconcileDeployment(db, manifest, { apply: true, descriptor, config, singleOwner: true });
  // Database commit precedes publication. A crash here leaves no ready listener;
  // restart retries the no-op apply and publishes the same stable bindings.
  await publishDeploymentBindings(descriptor, result);
}

export async function publishDeploymentBindings(descriptor: import("./runtime.js").DeploymentDescriptor,
  result: { owner: string; bindings: Record<string, string> }) {
  const target = join(descriptor.home, "instances", descriptor.instance, "deployment-bindings.json");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}`;
  const output = await open(temp, "wx", 0o600);
  try {
    try {
      await output.writeFile(JSON.stringify({ version: 1, owner: result.owner, bindings: result.bindings }, null, 2) + "\n");
      await output.sync();
    } finally { await output.close(); }
    await rename(temp, target);
    const directory = await open(dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temp, { force: true }); }
}
