import { isCloudManagedInstance, type CloudInstanceEnv } from "./services/cloud-instance.js";

/** Trusted operator HTML only. This content is public and runs in the app origin. */
export function injectCloudUiSnippet(html: string, env: CloudInstanceEnv = process.env): string {
  const snippet = env.PAPERCLIP_CLOUD_UI_SNIPPET;
  if (!isCloudManagedInstance(env) || !snippet?.trim()) return html;
  return html.replace(/<\/body>/i, () => `${snippet}\n</body>`);
}
