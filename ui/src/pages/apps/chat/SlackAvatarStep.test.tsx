// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackAvatarContent } from "./SlackAvatarStep";
import { useSlackAvatarProgress } from "./slack-avatar-progress";

const containers: Array<{ root: ReturnType<typeof createRoot>; node: HTMLDivElement }> = [];
function render(element: React.ReactNode) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  containers.push({ root, node });
  flushSync(() => root.render(element));
  return { node, root };
}
afterEach(() => {
  for (const { root, node } of containers.splice(0)) { flushSync(() => root.unmount()); node.remove(); }
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }

describe("Slack avatar download", () => {
  it("rejects error responses and downloads the PNG on retry", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "image/png" }), blob: async () => new Blob(["png"], { type: "image/png" }) });
    vi.stubGlobal("fetch", fetch);
    const createObjectURL = vi.fn(() => "blob:avatar");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn(); });
    const downloaded: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded.push(this.download); });
    const { node } = render(<SlackAvatarContent agentName="Maya" appName="Maya / App" avatarUrl="/api/agent-avatars/cap-v1/cherry-pop/rest.png?size=512&scale=1" />);
    const clickDownload = async () => {
      flushSync(() => node.querySelector('a[download]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      await settle();
    };
    await clickDownload();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t download");
    expect(downloaded).toEqual([]);
    await clickDownload();
    expect(downloaded).toEqual(["Maya-App-avatar.png"]);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(node.querySelector('[role="alert"]')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:avatar");
  });
  it("does not download a successful HTML login response as an image", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ "content-type": "text/html" }) }));
    const { node } = render(<SlackAvatarContent agentName="Maya" appName="Maya" avatarUrl="/avatar.png" />);
    flushSync(() => node.querySelector('a[download]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    await settle();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t download");
  });
});

function Progress({ company, endpoint }: { company: string; endpoint: string }) {
  const { progress, save } = useSlackAvatarProgress(company, endpoint);
  return <button onClick={() => save("skipped")}>{progress ?? "pending"}</button>;
}
describe("optional avatar progress", () => {
  it("keeps progress scoped to the company and endpoint", () => {
    const { root, node } = render(<Progress company="one" endpoint="a" />);
    flushSync(() => node.querySelector("button")!.click());
    expect(node.textContent).toBe("skipped");
    flushSync(() => root.render(<Progress company="one" endpoint="b" />));
    expect(node.textContent).toBe("pending");
    flushSync(() => root.render(<Progress company="two" endpoint="a" />));
    expect(node.textContent).toBe("pending");
    flushSync(() => root.render(<Progress company="one" endpoint="a" />));
    expect(node.textContent).toBe("skipped");
  });
  it("allows skipping even if browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
    const { node } = render(<Progress company="one" endpoint="a" />);
    flushSync(() => node.querySelector("button")!.click());
    expect(node.textContent).toBe("skipped");
  });
});
