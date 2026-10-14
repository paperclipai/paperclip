// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it, vi} from "vitest";
import {SpekoProviderSetup} from "./SpekoProviderSetup";
it("recovers interrupted setup with a signing secret, and preserves saved secrets on reconnect", async () => {
  const onConnect = vi.fn(), onChange = vi.fn();
  const props = {agentName: "Agent", callbackUrl: "https://test.invalid/callback", repairing: true,
    credentials: {apiKey: "synthetic", agentId: "agent_fixture"}, onConnect, onChange};
  const container = document.createElement("div"), root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () => root.render(<SpekoProviderSetup {...props} signingSecretConfigured={false} />));
    await act(async () => (container.querySelector("button:last-child") as HTMLButtonElement).click());
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({signingSecret: expect.stringMatching(/^whsec_/)}));
    await act(async () => root.render(<SpekoProviderSetup {...props} signingSecretConfigured />));
    await act(async () => (container.querySelector("button:last-child") as HTMLButtonElement).click());
    expect(onConnect).toHaveBeenLastCalledWith(props.credentials);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
