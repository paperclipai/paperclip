// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectToolAppResult, MachineSignInSetupResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSignInSetup, type MachineSignInClient } from "./MachineSignInSetup";

vi.mock("@/api/tools", () => ({ toolsApi: {} }));

const draft = {
  connectionId: "connection-1",
  connection: {},
  machineSignIn: {
    connectionId: "connection-1", method: "paperclip_key", clientId: null, issuer: "https://auth.example", tokenUrl: "https://auth.example/token",
    scopes: [], hasClientSecret: false, lastTokenAt: null, pendingPublicKey: null,
    publicKey: { keyId: "kid-1", algorithm: "RS256", pem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n", jwk: { kty: "RSA", kid: "kid-1" }, createdAt: "2026-11-13T00:00:00Z" },
  },
} as unknown as MachineSignInSetupResult;

describe("Machine sign-in setup", () => {
  let root: Root;
  let container: HTMLDivElement;
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const button = (name: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  const click = async (name: string) => { await act(async () => { button(name)!.click(); }); await flush(); };
  const type = async (id: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("creates a key, shows the public key to register, then tests with the client ID", async () => {
    const client: MachineSignInClient = {
      create: vi.fn(async () => draft),
      test: vi.fn(async () => ({ connectionId: "connection-1" }) as ConnectToolAppResult),
      status: vi.fn(),
    };
    const onConnected = vi.fn();
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" client={client} onBack={() => undefined} onConnected={onConnected} />);
    });
    expect(container.textContent).toContain("Paperclip key (recommended)");
    await click("Create key");
    expect(client.create).toHaveBeenCalledWith("company-1", { link: "https://mcp.example/mcp", method: "paperclip_key" });
    expect(container.textContent).toContain("Register this public key");
    expect(container.querySelector("textarea")?.value).toContain("BEGIN PUBLIC KEY");
    expect(button("Test connection")?.disabled).toBe(true);
    await type("machine-sign-in-client-id-confirm", "paperclip-automation");
    await click("Test connection");
    expect(client.test).toHaveBeenCalledWith("connection-1", { clientId: "paperclip-automation", scopes: "" });
    expect(onConnected).toHaveBeenCalled();
  });

  it("keeps the draft and shows the provider's answer when the test fails", async () => {
    const client: MachineSignInClient = {
      create: vi.fn(async () => draft),
      test: vi.fn(async () => { throw new Error("The provider didn't accept Paperclip's key."); }),
      status: vi.fn(),
    };
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" client={client} initialSetup={draft} onBack={() => undefined} onConnected={() => undefined} />);
    });
    await type("machine-sign-in-client-id-confirm", "wrong");
    await click("Test connection");
    expect(container.textContent).toContain("Machine sign-in didn’t work");
    expect(container.textContent).toContain("The provider didn't accept Paperclip's key.");
    expect(container.textContent).toContain("Register this public key");
  });

  it("asks for the client ID and secret together for a client secret", async () => {
    const client: MachineSignInClient = {
      create: vi.fn(async () => ({ ...draft, machineSignIn: { ...draft.machineSignIn, method: "client_secret" as const, publicKey: null } })),
      test: vi.fn(async () => ({}) as ConnectToolAppResult),
      status: vi.fn(),
    };
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" client={client} initialMethod="client_secret" applicationId="app-1" onBack={() => undefined} onConnected={() => undefined} />);
    });
    expect(button("Test connection")?.disabled).toBe(true);
    await type("machine-sign-in-client-id", "id-1");
    await type("machine-sign-in-client-secret", "secret-1");
    await click("Test connection");
    expect(client.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ method: "client_secret", clientId: "id-1", clientSecret: "secret-1", applicationId: "app-1" }));
    expect(client.test).toHaveBeenCalledWith("connection-1", { clientId: "id-1", scopes: "" });
  });

  it("lets a wrong secret be replaced after a failed test", async () => {
    const secretDraft = { ...draft, machineSignIn: { ...draft.machineSignIn, method: "client_secret" as const, publicKey: null, clientId: "id-1", hasClientSecret: true, scopes: ["a.read"] } };
    const client: MachineSignInClient = {
      create: vi.fn(),
      test: vi.fn(async () => { throw new Error("The provider didn't accept the client ID and secret."); }),
      status: vi.fn(),
    };
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" client={client} initialSetup={secretDraft} onBack={() => undefined} onConnected={() => undefined} />);
    });
    await click("Test connection");
    expect(container.querySelector("#machine-sign-in-client-secret-replace")).not.toBeNull();
    await type("machine-sign-in-client-secret-replace", "fixed-secret");
    await type("machine-sign-in-scopes-confirm", "");
    await click("Test connection");
    expect(client.test).toHaveBeenLastCalledWith("connection-1", { clientId: "id-1", scopes: "", clientSecret: "fixed-secret" });
  });

  it("resumes the key draft this tab started instead of creating another", async () => {
    sessionStorage.setItem("paperclip.machine-sign-in-draft.v2:company-1:new:https://mcp.example/mcp", "connection-1");
    let finish!: (value: typeof draft.machineSignIn) => void;
    const client: MachineSignInClient = {
      create: vi.fn(),
      test: vi.fn(),
      status: vi.fn(() => new Promise<typeof draft.machineSignIn>((resolve) => { finish = resolve; })),
    };
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" client={client} onBack={() => undefined} onConnected={() => undefined} />);
    });
    // No second draft can be started while the saved one loads.
    expect(button("Create key")?.disabled).toBe(true);
    await act(async () => { finish(draft.machineSignIn); });
    await flush();
    expect(client.status).toHaveBeenCalledWith("connection-1");
    expect(container.textContent).toContain("Register this public key");
    expect(client.create).not.toHaveBeenCalled();
    sessionStorage.clear();
  });

  it("never resumes a draft started for a different app", async () => {
    const client: MachineSignInClient = {
      create: vi.fn(async () => draft),
      test: vi.fn(),
      status: vi.fn(async () => draft.machineSignIn),
    };
    // App A's setup creates a key draft in this tab, then the admin leaves it.
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" applicationId="app-a" client={client} onBack={() => undefined} onConnected={() => undefined} />);
    });
    await click("Create key");
    await act(async () => root.unmount());
    root = createRoot(container);
    // Setup for app B at the same address starts fresh instead of adopting A's draft.
    await act(async () => {
      root.render(<MachineSignInSetup companyId="company-1" link="https://mcp.example/mcp" applicationId="app-b" client={client} onBack={() => undefined} onConnected={() => undefined} />);
    });
    await flush();
    expect(client.status).not.toHaveBeenCalled();
    await click("Create key");
    expect(client.create).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ applicationId: "app-b" }));
    sessionStorage.clear();
  });
});
