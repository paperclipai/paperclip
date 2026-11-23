import {
  paperclipCloudConnectorEnrollmentStatus,
  type PaperclipCloudConnectorEnrollmentStatus,
} from "./paperclip-cloud-connector-enrollment.js";
import {
  createPaperclipCloudConnector,
  paperclipCloudConnectorConfigFromEnv,
} from "./paperclip-cloud-connector.js";

export async function reconcilePaperclipCloudConnectorEnrollmentStatus(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  onRemoved?: () => Promise<unknown>,
): Promise<PaperclipCloudConnectorEnrollmentStatus> {
  const local = paperclipCloudConnectorEnrollmentStatus(env);
  if (!local.configured) return local;
  const config = paperclipCloudConnectorConfigFromEnv(env);
  if (!config) return { ...local, configured: false, status: "not_configured" };
  try {
    const status = await createPaperclipCloudConnector({ config, request }).getConfirmedInstanceStatus();
    if (status === "active") return { ...local, configured: true, status: "active" };
    if (status === "suspended") return { ...local, configured: false, status: "suspended" };
    if (status === "removed") await onRemoved?.().catch(() => undefined);
    return { ...local, configured: false, status: "not_configured" };
  } catch {
    return { ...local, configured: false, status: "unverified" };
  }
}
