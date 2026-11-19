// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TailscaleSshMachine } from "./TailscaleSshMachine";

const pairing = vi.hoisted(() => vi.fn());
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ source: "local_implicit", isInstanceAdmin: false }) } }));
vi.mock("@/api/tailscale", () => ({ tailscaleApi: {
  list: async () => [{ id: "connection", companyId: "company", name: "Home tailnet", status: "connected" }],
  devices: async () => [{ id: "device", name: "Workstation", address: "100.64.0.1", os: "linux", online: true }],
  pairing,
} }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));

const result = (port: number) => ({ privateKeySecretId: `key-${port}`, publicKey: "fixture public key", command: `pair workstation on port ${port}` });
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const onPrivateKey = vi.fn<(secretId: string) => void>();
function render(port: number, visible = true) {
  flushSync(() => root.render(<QueryClientProvider client={client}>
    {visible ? <TailscaleSshMachine companyId="company" connectionId="connection" deviceId="device" port={port}
      onPrivateKey={onPrivateKey} onChange={() => {}} /> : <p>Direct SSH configuration</p>}
  </QueryClientProvider>));
}
function prepare() {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === "Prepare machine pairing");
  expect(button).toBeDefined();
  flushSync(() => button!.click());
}
const command = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Machine pairing command"]');
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

describe("Tailscale SSH pairing selection", () => {
  beforeEach(() => {
    pairing.mockReset().mockImplementation(async (_company, _connection, _device, port) => result(port));
    onPrivateKey.mockReset();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });

  it("ignores a pending pairing response after switching to Direct", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    pairing.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(22); await settle(); prepare(); await settle();
    render(22, false);
    finish(result(22)); await settle();
    expect(onPrivateKey).not.toHaveBeenCalled();
    expect(command()).toBeNull();
  });

  it.each([false, true])("requires current-port pairing after a port edit (old request pending=%s)", async pending => {
    let finish!: (value: ReturnType<typeof result>) => void;
    if (pending) pairing.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(22); await settle(); prepare(); await settle();
    expect(pairing).toHaveBeenLastCalledWith("company", "connection", "device", 22);
    if (!pending) {
      expect(command()?.value).toBe(result(22).command);
      expect(onPrivateKey).toHaveBeenCalledWith("key-22");
    }
    onPrivateKey.mockClear();
    render(2222); await settle();
    if (pending) { finish(result(22)); await settle(); }
    expect(command()).toBeNull();
    expect(onPrivateKey).not.toHaveBeenCalled();
    prepare(); await settle();
    expect(pairing).toHaveBeenLastCalledWith("company", "connection", "device", 2222);
    expect(command()?.value).toBe(result(2222).command);
    expect(onPrivateKey).toHaveBeenCalledExactlyOnceWith("key-2222");
  });
});
