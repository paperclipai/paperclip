import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createGrpcClient, type GrpcClientOptions, type GrpcAdvancedIMessage } from "@photon-ai/advanced-imessage";
import { PhotonTransportResources } from "./transport-resources.js";
const require = createRequire(import.meta.url);
const deliveredGrpc = {
  "build/src/http_proxy.js": "56e1e38a2e933025212512edfebde611c80471e6b27b0570b29f1275fab46c85",
  "build/src/transport.js": "9b142290b2bcdf9eb4e75e70adbe6301689ff31e8f2e8bc957d22a6590e4be8c",
  "build/src/channel-options.js": "3d83c36164c8b0499ba39da0864b5a3e12a77c6f455ad7cfed55e942dbf8d4f0",
  "build/src/channel-credentials.js": "553fff7957c883c85925fe8fec9d912e02ddc29d073419747ed1737a00b66bc0"
};
const inspectedSdk = {
  "dist/chunk-5WYZRCOS.js": "f26e3ed5d8a076f0bb214fe05680c317d7c1123fb29f7dc727e3dd1ac54a0c69",
  "dist/chunk-EUYUM3KD.js": "1538679fbe4c509e80571c5096c7af9c5343975f6e171d9af89e4476eb951f2e",
  "dist/client-UZMHAKPA.js": "dd078953c237ed11abb42856739f547ba952acb8a8a42e77aefb3f9d130f6c15"
};
function installedRoot(name: string, version: string): string {
  let path = dirname(require.resolve(name));
  for (let parents = 0; parents < 6; parents++, path = dirname(path)) {
    let pkg: unknown;
    try { pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")); } catch { continue; }
    if (pkg && typeof pkg === "object" && Reflect.get(pkg, "name") === name) {
      if (Reflect.get(pkg, "version") !== version) throw new Error("Photon transport dependency version changed");
      return path;
    }
  }
  throw new Error("Photon transport dependency ownership is unavailable");
}
export function assertInstalledPhotonTransportJoin(): void {
  for (const [root, files] of [[installedRoot("@grpc/grpc-js", "1.14.5"), deliveredGrpc],
    [installedRoot("@photon-ai/advanced-imessage", "2.2.0"), inspectedSdk]] as const) {
    for (const [path, expected] of Object.entries(files)) {
      if (createHash("sha256").update(readFileSync(join(root, path))).digest("hex") !== expected)
        throw new Error("Photon transport close-and-join delivery is incomplete");
    }
  }
}
export function createOwnedPhotonClient(options: GrpcClientOptions): GrpcAdvancedIMessage {
  // Check exact installed delivery BEFORE allocating either SDK channel. This
  // prevents an unpatched dependency from silently turning no observations into
  // a successful close receipt.
  assertInstalledPhotonTransportJoin();
  const resources = new PhotonTransportResources();
  const client = createGrpcClient({ ...options, channelOptions: { ...options.channelOptions,
    "grpc.use_local_subchannel_pool": 1, "grpc-node.transport_owner": resources } });
  const closeSdk = client.close.bind(client);
  let closing: Promise<void> | undefined, joined = false;
  client.close = () => {
    if (joined) return Promise.resolve();
    if (closing) return closing;
    resources.beginClose();
    const attempt = (async () => {
      const errors: unknown[] = [];
      try { await closeSdk(); } catch (error) { errors.push(error); }
      try { await resources.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Photon SDK and physical transport close remain incomplete");
    })();
    closing = attempt;
    void attempt.then(() => { joined = true; }, () => { if (closing === attempt) closing = undefined; });
    return attempt;
  };
  return client;
}
