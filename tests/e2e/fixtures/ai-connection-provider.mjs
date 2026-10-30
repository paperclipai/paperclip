// Only the upstream credential check is simulated. The vault, card, adoption,
// runtime credential selection, and continuation delivery use real Paperclip APIs.
if (process.env.NODE_ENV === "test") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.hostname === "api.anthropic.com"
      && headers.get("x-api-key") === "paperclip-e2e-personal-claude-key") {
      return url.pathname === "/v1/models"
        ? Response.json({ data: [], has_more: false })
        : Response.json({ error: "Unsupported fixture Anthropic request" }, { status: 422 });
    }
    return realFetch(input, init);
  };
}
