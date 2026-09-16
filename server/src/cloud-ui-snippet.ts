import { isCloudManagedInstance, type CloudInstanceEnv } from "./services/cloud-instance.js";

/** Trusted operator HTML only. This content is public and runs in the app origin. */
export function injectCloudUiSnippet(html: string, env: CloudInstanceEnv = process.env): string {
  const snippet = resolveCloudUiSnippet(env);
  if (!isCloudManagedInstance(env) || !snippet) return html;
  return html.replace(/<\/body>/i, () => `${snippet}\n</body>`);
}

/**
 * A present plain variable always wins — blank included, so clearing it to
 * blank disables injection even when a base64 value is still deployed. The
 * base64 variant exists because delivery pipelines that write env vars
 * through provider APIs can sit behind web application firewalls that
 * reject values containing raw script markup; base64 carries the same
 * snippet through them unchanged.
 */
function resolveCloudUiSnippet(env: CloudInstanceEnv): string | null {
  const plain = env.PAPERCLIP_CLOUD_UI_SNIPPET;
  if (plain !== undefined) return asInjectableMarkup(plain);
  const encoded = env.PAPERCLIP_CLOUD_UI_SNIPPET_B64?.replace(/\s+/g, "");
  if (!encoded) return null;
  const decoded = decodeBase64(encoded);
  return decoded !== null ? asInjectableMarkup(decoded) : null;
}

/**
 * A configured value that already looks like markup (it starts with `<`) is
 * injected verbatim, preserving the original bytes. A value that does not is
 * treated as a bare script body and wrapped in a `<script>` element.
 *
 * The bare-body form exists for the WAF case above: even base64 no longer
 * carries raw script markup past every provider firewall, because some now
 * base64-decode the value before matching. A body with no `<script` marker
 * clears them, and the tenant restores the element here — the one place the
 * value is trusted app-origin HTML rather than a provider API payload.
 * Blank in either form stays disabled.
 */
function asInjectableMarkup(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("<") ? value : `<script>${value}</script>`;
}

/**
 * A value that is not canonical, padded base64 of valid UTF-8 is ignored
 * rather than injected as garbage: the round trip rejects stray padding
 * bits, and the fatal decoder rejects byte sequences that are not UTF-8.
 */
function decodeBase64(encoded: string): string | null {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
