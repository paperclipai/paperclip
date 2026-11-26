export function tracingInstanceHost(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PAPERCLIP_TRACING_INSTANCE_HOST !== "true" || !env.PAPERCLIP_PUBLIC_URL) return;
  const url = URL.parse(env.PAPERCLIP_PUBLIC_URL);
  if (url?.protocol === "https:" || url?.protocol === "http:") return url.hostname;
}
