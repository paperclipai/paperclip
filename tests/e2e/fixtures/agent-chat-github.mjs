// Upstream GitHub simulation only. Paperclip's discovery, secret resolution,
// responsible-user authorization, and project creation all remain real.
if (process.env.NODE_ENV === "test") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (
      url.hostname === "api.github.com" &&
      headers.get("authorization") === "Bearer paperclip-e2e-repository-fixture"
    ) {
      if (url.pathname !== "/user/repos")
        return Response.json(
          { error: "Unsupported fixture GitHub request" },
          { status: 422 },
        );
      return Response.json([
        { id: 101, full_name: "chat-fixture/frontend", private: false },
        { id: 102, full_name: "chat-fixture/backend", private: false },
      ]);
    }
    return realFetch(input, init);
  };
}
