import { describe, expect, it } from "vitest";
import type { WorkFile } from "@paperclipai/shared";
import { createWorkFolderFixture } from "./workFolders";

const root =
  "http://storybook.test/api/companies/company-storybook/work-folders/task/issue-storybook-1";
type Fixture = ReturnType<typeof createWorkFolderFixture>;
function request(fixture: Fixture, suffix = "", init?: RequestInit) {
  return fixture.handle(new Request(`${root}${suffix}`, init));
}
async function files(fixture: Fixture, trash = false): Promise<WorkFile[]> {
  return (await (await request(fixture, `?trash=${trash}`))!.json()).files;
}
function operation(
  fixture: Fixture,
  action: string,
  fields: Record<string, string>,
) {
  return request(fixture, "/operations", {
    method: "POST",
    body: JSON.stringify({ action, ...fields }),
  });
}

describe("work-folder Storybook fixtures", () => {
  it("handles the project page's workspace query without a backend", async () => {
    const fixture = createWorkFolderFixture();
    const response = await fixture.handle(
      new Request(
        "http://storybook.test/api/companies/company-storybook/execution-workspaces?projectId=project-board-ui",
      ),
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual([]);
  });

  it("keeps uploads within one owner and resets them for the next story", async () => {
    const fixture = createWorkFolderFixture("empty");
    const bytes = new Uint8Array([0, 255, 128, 10]);
    await request(fixture, "/content?path=nested%2Fsample.bin", {
      method: "PUT",
      body: bytes,
    });
    const downloaded = await request(
      fixture,
      "/content?path=nested%2Fsample.bin",
    );
    expect(new Uint8Array(await downloaded!.arrayBuffer())).toEqual(bytes);
    expect(await files(fixture)).toHaveLength(1);
    const otherOwner = await fixture.handle(
      new Request(root.replace("/task/issue-storybook-1", "/user/user-board")),
    );
    expect((await otherOwner!.json()).files).toEqual([]);
    expect(await files(createWorkFolderFixture("empty"))).toEqual([]);
    expect(
      await fixture.handle(
        new Request(
          "http://storybook.test/api/companies/real-company/work-folders/task/task-1",
        ),
      ),
    ).toBeNull();
  });

  it("restores a deleted directory and purges its content without affecting siblings", async () => {
    const fixture = createWorkFolderFixture("empty");
    await operation(fixture, "mkdir", { path: "notes" });
    await request(fixture, "/content?path=notes%2Fempty.txt", {
      method: "PUT",
      body: "",
    });
    await request(fixture, "/content?path=notes-extra.txt", {
      method: "PUT",
      body: "Keep me",
    });
    await operation(fixture, "delete", { path: "notes" });
    expect((await files(fixture)).map((file) => file.path)).toEqual([
      "notes-extra.txt",
    ]);
    const directory = (await files(fixture, true)).find(
      (file) => file.kind === "directory",
    )!;
    await operation(fixture, "restore", { fileId: directory.id });
    expect(await files(fixture, true)).toEqual([]);
    expect(
      await (await request(fixture, "/content?path=notes%2Fempty.txt"))!.text(),
    ).toBe("");
    await operation(fixture, "delete", { path: "notes" });
    await operation(fixture, "purge", { fileId: directory.id });
    expect(await files(fixture, true)).toEqual([]);
    expect(
      (await request(fixture, "/content?path=notes%2Fempty.txt"))!.status,
    ).toBe(404);
    expect(
      await (await request(fixture, "/content?path=notes-extra.txt"))!.text(),
    ).toBe("Keep me");
  });

  it("preserves existing content when an upload failure is demonstrated", async () => {
    const fixture = createWorkFolderFixture("uploadFailed");
    const before = await (await request(
      fixture,
      "/content?path=README.md",
    ))!.text();
    const response = await request(fixture, "/content?path=README.md", {
      method: "PUT",
      body: "replacement",
    });
    expect(response!.status).toBe(503);
    expect(
      await (await request(fixture, "/content?path=README.md"))!.text(),
    ).toBe(before);
  });
});
