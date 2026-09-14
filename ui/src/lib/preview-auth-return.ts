/** The preview grant is an HTTP redirect endpoint, not a client-side page.
 * Restrict full navigations after login to this exact same-origin callback. */
export function previewAuthReturnPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  const base = "https://paperclip.invalid";
  const url = new URL(value, base);
  if (url.origin !== base || !/^\/api\/companies\/[a-f0-9-]{36}\/runtime-services\/[a-f0-9-]{36}\/preview-access$/.test(url.pathname)) return null;
  return url.pathname + url.search;
}
