import { describe, expect, it, vi } from "vitest";
import { azureDevOpsAuthorization, loadAzureDevOpsRepositories } from "./repositories.js";

describe("Azure DevOps repository discovery", () => {
  it("cancels an oversized provider response while reading", async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (chunks++ < 6) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); },
      cancel() { cancelled = true; },
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(loadAzureDevOpsRepositories("org", {}, request)).rejects.toThrow(/limit/i);
    expect(cancelled).toBe(true);
  });
  it("creates the provider-specific authorization header without embedding credentials in URLs", () => {
    expect(azureDevOpsAuthorization({ kind: "pat", token: "fixture-pat" })).toBe(`Basic ${Buffer.from(":fixture-pat").toString("base64")}`);
    expect(azureDevOpsAuthorization({ kind: "entra", token: "fixture-token" })).toBe("Bearer fixture-token");
    expect(() => azureDevOpsAuthorization({ kind: "pat", token: "bad\r\ntoken" })).toThrow();
  });
  it("constructs trusted URLs and keeps organization and project in the label", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ value: [
      { id: "01234567-89ab-cdef-0123-456789abcdef", name: "Source Repo", project: { name: "My Project" }, remoteUrl: "https://evil.example/token" },
    ] })));
    const result = await loadAzureDevOpsRepositories("my-org", { Authorization: "Bearer token" }, request);
    expect(result).toEqual([{ provider: "azure-devops", id: "my-org:01234567-89ab-cdef-0123-456789abcdef", fullName: "my-org/My Project/Source Repo", url: "https://dev.azure.com/my-org/My%20Project/_git/Source%20Repo", private: true }]);
    expect(request.mock.calls[0]?.[0]).toBe("https://dev.azure.com/my-org/_apis/git/repositories?api-version=7.1");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects unsafe organizations and invalid provider responses without disclosing response bodies", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(loadAzureDevOpsRepositories("../other", {}, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response("secret", { status: 401 }));
    await expect(loadAzureDevOpsRepositories("org", {}, request)).rejects.toThrow(/Azure DevOps/);
    request.mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: "invalid", name: "repo", project: { name: "project" } }] })));
    await expect(loadAzureDevOpsRepositories("org", {}, request)).rejects.toThrow(/Azure DevOps/);
  });
});
