import { execSync } from "node:child_process";

/**
 * Installs Cilium into a kind cluster using the Cilium CLI. Requires
 * `cilium` on PATH (install via `brew install cilium-cli` or per the
 * Cilium docs).
 *
 * The kind cluster MUST have been started first via spinUpKind() in
 * _harness.ts; we just install Cilium on top.
 */
export function installCilium(kubeconfigPath: string): void {
  // Cilium 1.16+ ships a kind-friendly default; we don't override anything
  // beyond enabling kubeProxyReplacement so kind's default kube-proxy is
  // bypassed. The default node image (kind v0.24.0 → kindest/node:v1.31.x)
  // works without further tuning.
  execSync(
    `cilium install --version 1.16.0 --set kubeProxyReplacement=true`,
    { stdio: "inherit", env: { ...process.env, KUBECONFIG: kubeconfigPath } },
  );
}

/**
 * Block until Cilium is fully Ready in the kind cluster. The CLI's
 * `cilium status --wait` polls cilium-operator + DaemonSet rollout and
 * exits 0 when everything is green.
 */
export function waitForCiliumReady(kubeconfigPath: string): void {
  execSync(
    `cilium status --wait`,
    { stdio: "inherit", env: { ...process.env, KUBECONFIG: kubeconfigPath } },
  );
}
