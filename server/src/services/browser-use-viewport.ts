import { isIP, type TcpNetConnectOpts } from "node:net";
import WebSocket from "ws";
import {
  BROWSER_USE_VIEWPORT_PRESETS,
  type BrowserUseViewportPreset,
  type BrowserUseViewportRequest,
  type BrowserUseViewportState,
} from "@paperclipai/shared";
import {
  BrowserUseError,
  type BrowserUseRequest,
} from "./browser-use-client.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { resolveApprovedRemoteHttpAddresses } from "./remote-http-endpoint-guard.js";

const unavailable = () =>
  new BrowserUseError(
    502,
    "Browser size could not be changed. Reconnect the view and try again.",
  );
const unsupported = () =>
  new BrowserUseError(
    409,
    "This browser does not support resizing. Ask the agent to open a new browser, then try again.",
  );
/** Credential-bearing URLs stay in memory and must never reach logs or clients. */
export function browserUseCdpUrl(
  value: unknown,
  browserId: string,
  protocol: "https:" | "wss:",
) {
  try {
    const url = new URL(String(value));
    if (
      !/^[\da-f-]{36}$/i.test(browserId) ||
      url.protocol !== protocol ||
      url.hostname !== `${browserId}.cdp.browser-use.com` ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw unavailable();
    return url;
  } catch {
    throw unavailable();
  }
}
async function connectSocket(url: URL) {
  const dnsUrl = new URL(url);
  dnsUrl.protocol = "https:";
  const addresses = await resolveApprovedRemoteHttpAddresses(
    dnsUrl,
    {},
    unavailable,
  );
  const options: WebSocket.ClientOptions &
    Pick<TcpNetConnectOpts, "autoSelectFamily" | "lookup"> = {
    followRedirects: false,
    handshakeTimeout: 10000,
    maxPayload: 1_000_000,
    autoSelectFamily: false,
    // Pin the validated public address while retaining TLS SNI/certificate checks.
    lookup: (_hostname, _options, callback) =>
      callback(null, addresses[0], isIP(addresses[0])),
  };
  const socket = new WebSocket(url, options);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.on("error", () => reject(unavailable()));
    socket.once("close", () => reject(unavailable()));
  });
  return socket;
}

/** Keep CDP attached: Chromium clears emulation when its owning session detaches. */
export function createBrowserUseViewportManager(
  deps: {
    request?: BrowserUseRequest;
    connect?: (url: URL) => Promise<WebSocket>;
    now?: () => number;
  } = {},
) {
  const now = deps.now ?? Date.now;
  const leaseMs = 20_000;
  type Client = Awaited<ReturnType<typeof open>>;
  const clients = new Map<string, Promise<Client>>();
  async function open(browserId: string, address: string, expiresAt?: string) {
    const origin = browserUseCdpUrl(address, browserId, "https:");
    origin.pathname = "/json/version";
    const request =
      deps.request ??
      ((url, init) =>
        guardedRemoteHttpFetch(url, init, { error: unavailable }));
    const response = await request(origin.href, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const text = await response.text();
    if (text.length > 100_000) throw unavailable();
    const endpoint = browserUseCdpUrl(
      JSON.parse(text).webSocketDebuggerUrl,
      browserId,
      "wss:",
    );
    const socket = await (deps.connect ?? connectSocket)(endpoint);
    const owner = clients.get(browserId);
    const forget = () => {
      if (clients.get(browserId) === owner) clients.delete(browserId);
    };
    let sequence = 0;
    let selection: BrowserUseViewportState = { preset: "fit" };
    let desired = selection;
    let lease: { owner: string; until: number } | null = null;
    const state = (owner?: string): BrowserUseViewportState => ({
      ...selection,
      controlledElsewhere: Boolean(
        lease && lease.until > now() && lease.owner !== owner,
      ),
    });
    let queue = Promise.resolve();
    const pages = new Map<string, string>();
    const pending = new Map<
      number,
      {
        resolve: (data: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const command = (
      method: string,
      params: object = {},
      sessionId?: string,
    ): Promise<any> =>
      new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(unavailable());
          return;
        }
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(unavailable());
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    const apply = async (sessionId: string, value: BrowserUseViewportState) => {
      const size =
        value.preset === "fit"
          ? value.width && value.height
            ? { width: value.width, height: value.height }
            : null
          : BROWSER_USE_VIEWPORT_PRESETS.find((p) => p.id === value.preset);
      if (!size) {
        await command("Emulation.clearDeviceMetricsOverride", {}, sessionId);
        return;
      }
      await command(
        "Emulation.setDeviceMetricsOverride",
        {
          width: size.width,
          height: size.height,
          screenWidth: size.width,
          screenHeight: size.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      );
      const result = await command(
        "Runtime.evaluate",
        {
          expression: "({width: innerWidth, height: innerHeight})",
          returnByValue: true,
        },
        sessionId,
      );
      if (
        result.result?.value?.width !== size.width ||
        result.result?.value?.height !== size.height
      )
        throw unsupported();
    };
    const attach = async (target: { targetId: string; type: string }) => {
      if (target.type !== "page" || pages.has(target.targetId)) return;
      const { sessionId } = await command("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      pages.set(target.targetId, sessionId);
      await apply(sessionId, desired);
    };
    const close = () => {
      forget();
      socket.terminate();
    };
    const expiry = setTimeout(
      close,
      Math.max(
        1000,
        Math.min(
          4 * 60 * 60 * 1000,
          expiresAt ? Date.parse(expiresAt) - Date.now() : 4 * 60 * 60 * 1000,
        ),
      ),
    );
    expiry.unref();
    socket.on("error", close);
    socket.on("close", () => {
      forget();
      clearTimeout(expiry);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(unavailable());
      }
      pending.clear();
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        const p = pending.get(message.id);
        if (p) {
          pending.delete(message.id);
          clearTimeout(p.timer);
          message.error ? p.reject(unavailable()) : p.resolve(message.result);
        } else if (message.method === "Target.targetCreated") {
          queue = queue
            .then(() => attach(message.params.targetInfo))
            .catch(close);
        } else if (message.method === "Target.targetDestroyed") {
          pages.delete(message.params.targetId);
        }
      } catch {
        close();
      }
    });
    try {
      const { targetInfos } = await command("Target.getTargets");
      for (const target of targetInfos) await attach(target);
      await command("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      close();
      throw error;
    }
    return {
      state,
      close,
      releaseLease(owner: string) {
        if (lease?.owner === owner) lease = null;
      },
      async resize(value: BrowserUseViewportRequest, owner: string) {
        let applied = false;
        const operation = queue.then(async () => {
          // Check inside the queue: a manual selection must defeat older auto updates.
          if (
            value.preset === "fit" &&
            !value.takeControl &&
            (selection.preset !== "fit" ||
              (lease && lease.until > now() && lease.owner !== owner))
          )
            return;
          const previous = selection;
          const previousLease = lease;
          desired =
            value.preset === "fit"
              ? { preset: "fit", width: value.width, height: value.height }
              : { preset: value.preset };
          lease =
            value.preset === "fit" ? { owner, until: now() + leaseMs } : null;
          if (JSON.stringify(desired) === JSON.stringify(previous)) return;
          try {
            if (!pages.size) throw unavailable();
            for (const sessionId of pages.values())
              await apply(sessionId, desired);
            selection = desired;
            applied = true;
          } catch (error) {
            desired = previous;
            lease = previousLease;
            for (const sessionId of pages.values())
              await apply(sessionId, previous).catch(close);
            throw error;
          }
        });
        queue = operation.catch(() => {});
        await operation;
        return { ...state(owner), applied };
      },
    };
  }
  return {
    async current(
      browserId: string,
      owner?: string,
    ): Promise<BrowserUseViewportState> {
      return clients.has(browserId)
        ? ((await clients.get(browserId)!.catch(() => null))?.state(owner) ?? {
            preset: "fit",
          })
        : { preset: "fit" };
    },
    async releaseLease(browserId: string, owner: string) {
      await clients
        .get(browserId)
        ?.then((client) => client.releaseLease(owner))
        .catch(() => {});
    },
    async resize(
      browserId: string,
      address: string,
      input:
        | BrowserUseViewportRequest
        | Exclude<BrowserUseViewportPreset, "fit">,
      expiresAt?: string,
      owner = "",
    ) {
      const value = typeof input === "string" ? { preset: input } : input;
      try {
        if (!clients.has(browserId))
          clients.set(browserId, open(browserId, address, expiresAt));
        const client = await clients.get(browserId)!;
        return await client.resize(value, owner);
      } catch (error) {
        if (error instanceof BrowserUseError && error.status === 409)
          throw error;
        const client = clients.get(browserId);
        clients.delete(browserId);
        await client?.then((c) => c.close()).catch(() => {});
        throw unavailable();
      }
    },
    async release(browserId: string) {
      const client = clients.get(browserId);
      clients.delete(browserId);
      await client?.then((c) => c.close()).catch(() => {});
    },
  };
}
export const browserUseViewports = createBrowserUseViewportManager();
