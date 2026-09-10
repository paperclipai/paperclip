import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";

type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
  url: string;
  __paperclipListening?: Promise<void>;
  assert(error: Error, response: undefined, callback?: SupertestCallback): void;
};

type SupertestCallback = (error: Error | null, response?: unknown) => void;

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    end(this: SupertestTestInstance, callback?: SupertestCallback): SupertestTestInstance;
    __paperclipLoopbackPatched?: boolean;
  };
};

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
}

// The automatic Tailscale HTTPS default (PAP-17158) probes for a real host
// broker socket, so leaving it enabled would make every test that starts a
// service named `paperclip-dev` behave differently on a broker-capable host
// than on CI. Tests that exercise the default opt in explicitly.
if (!process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS) {
  process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "off";
}

if (!SupertestTest.prototype.__paperclipLoopbackPatched) {
  const pendingListeners = new WeakMap<SupertestServer, Promise<void>>();
  const originalEnd = SupertestTest.prototype.end;

  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const protocol = app instanceof TlsServer ? "https" : "http";
    const addressUrl = () => {
      const address = app.address() as AddressInfo | string | null;
      if (!address || typeof address === "string") {
        throw new Error("Expected Supertest server to listen on a TCP port");
      }
      const host = address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
      return `${protocol}://${host.includes(":") ? `[${host === "::" ? "::1" : host}]` : host}:${address.port}${path}`;
    };

    if (app.address()) return addressUrl();

    // A wildcard ephemeral listener can overlap an existing loopback listener
    // on macOS. Bind the address we actually request, and await the asynchronous
    // bind before Superagent resolves the URL or sends any request bytes.
    let listening = pendingListeners.get(app);
    if (!listening) {
      listening = new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          app.off("listening", onListening);
          pendingListeners.delete(app);
          reject(error);
        };
        const onListening = () => {
          app.off("error", onError);
          pendingListeners.delete(app);
          resolve();
        };
        app.once("error", onError);
        app.once("listening", onListening);
        app.listen(0, "127.0.0.1");
      });
      pendingListeners.set(app, listening);
    }
    this._server = app;
    this.__paperclipListening = listening.then(() => { this.url = addressUrl(); });
    // A request may be configured before the caller attaches its callback.
    void this.__paperclipListening.catch(() => {});
    return `${protocol}://127.0.0.1:0${path}`;
  };

  SupertestTest.prototype.end = function end(callback) {
    if (!this.__paperclipListening) return originalEnd.call(this, callback);
    void this.__paperclipListening.then(
      () => { originalEnd.call(this, callback); },
      (error: Error) => { this.assert(error, undefined, callback); },
    );
    return this;
  };

  SupertestTest.prototype.__paperclipLoopbackPatched = true;
}
