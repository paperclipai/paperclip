/**
 * Mirrors host env loading from playwright.config (globalSetup runs in a child process).
 */
import { loadHostEnv } from "./host-env";

async function globalSetup() {
  loadHostEnv(process.cwd());
  console.log("[realllm] Global setup OK (host-env: infra/.env + .env + optional extra)");
}

export default globalSetup;
