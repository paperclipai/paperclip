import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KindCluster {
  name: string;
  kubeconfigPath: string;
  kubeconfigYaml: string;
  cleanup(): void;
}

export function spinUpKind(): KindCluster {
  const name = `pp-test-${Math.random().toString(36).slice(2, 8)}`;
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const kubeconfigPath = join(dir, "kubeconfig");
  // --wait waits for the control plane Pod to be Ready before returning.
  execSync(`kind create cluster --name ${name} --kubeconfig ${kubeconfigPath} --wait 90s`, {
    stdio: "inherit",
  });
  const kubeconfigYaml = readFileSync(kubeconfigPath, "utf-8");
  return {
    name,
    kubeconfigPath,
    kubeconfigYaml,
    cleanup: () => {
      try { execSync(`kind delete cluster --name ${name}`, { stdio: "ignore" }); } catch { /* swallow */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
    },
  };
}
