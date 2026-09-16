/**
 * Cookie jar for the Capability smoke scripts.
 *
 * Every session-scoped route is bound to a per-browser capability cookie
 * (track 7U), so a script that drives those routes has to behave like one
 * browser: carry the capability it was given, and adopt the replacement when a
 * reset or a new chat rotates it. A browser does this for free; `fetch` does
 * not, which is what this small jar supplies.
 */
export function createCapabilityCookieJar(origin) {
  const cookies = new Map();

  function capture(response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  function header() {
    if (cookies.size === 0) return {};
    return { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  }

  return {
    /** One request through this jar, capturing any rotated capability. */
    async fetch(path, init = {}) {
      const response = await fetch(`${origin}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), ...header() },
      });
      capture(response);
      return response;
    },
    value(name) {
      return cookies.get(name);
    },
  };
}
