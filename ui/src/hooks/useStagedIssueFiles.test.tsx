// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStagedIssueFiles, writeStagedIssueFiles, type StagedIssueFile } from "../lib/staged-issue-files";
import { useStagedIssueFiles } from "./useStagedIssueFiles";

vi.mock("../lib/staged-issue-files", () => ({
  readStagedIssueFiles: vi.fn(),
  writeStagedIssueFiles: vi.fn(),
}));

const image: StagedIssueFile = { id: "image", kind: "attachment", file: new File(["bytes"], "reference.png", { type: "image/png" }) };
let current: ReturnType<typeof useStagedIssueFiles>;
function Harness({ owner = "user-a", company = "company-a", pending = false }: { owner?: string; company?: string; pending?: boolean }) {
  current = useStagedIssueFiles(pending ? undefined : owner, company);
  return <div>{current.files.map(item => item.file.name).join(",")}{current.error}</div>;
}

describe("staged task file recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.mocked(readStagedIssueFiles).mockReset().mockResolvedValue([]);
    vi.mocked(writeStagedIssueFiles).mockReset().mockResolvedValue();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it.each(["owner", "company"] as const)("ignores an old restore after the %s changes", async (field) => {
    let release!: (files: StagedIssueFile[]) => void;
    vi.mocked(readStagedIssueFiles).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness {...(field === "owner" ? { owner: "user-b" } : { company: "company-b" })} />));
    await act(async () => release([image]));
    expect(container.textContent).not.toContain("reference.png");
    expect(current.restoring).toBe(false);
    expect(writeStagedIssueFiles).not.toHaveBeenCalled();
  });

  it("retains selected files and reports unavailable browser storage", async () => {
    vi.mocked(writeStagedIssueFiles).mockRejectedValue(new Error("quota exceeded"));
    await act(async () => root.render(<Harness />));
    await act(async () => current.setFiles([image]));
    expect(container.textContent).toContain("reference.png");
    expect(container.textContent).toContain("Keep this page open");
    vi.mocked(writeStagedIssueFiles).mockResolvedValue();
    await act(async () => current.setFiles([]));
    expect(container.textContent).toBe("");
  });

  it("allows file selection after a failed restore and clears the error after saving", async () => {
    vi.mocked(readStagedIssueFiles).mockRejectedValue(new Error("storage unavailable"));
    await act(async () => root.render(<Harness />));
    expect(container.textContent).toContain("Saved files could not be restored");
    expect(current.restoring).toBe(false);
    await act(async () => current.setFiles([image]));
    expect(container.textContent).toBe("reference.png");
  });

  it("keeps files selected before the account is known", async () => {
    await act(async () => root.render(<Harness pending />));
    await act(async () => current.setFiles([image]));
    await act(async () => root.render(<Harness />));
    expect(container.textContent).toBe("reference.png");
    expect(writeStagedIssueFiles).toHaveBeenCalledWith(JSON.stringify(["user-a", "company-a"]), [image], []);
  });

  it("deletes only files removed from this mounted draft", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => current.setFiles([image]));
    await act(async () => current.setFiles([]));
    expect(writeStagedIssueFiles).toHaveBeenLastCalledWith(JSON.stringify(["user-a", "company-a"]), [], [image.id]);
    await act(async () => current.setFiles([image]));
    expect(writeStagedIssueFiles).toHaveBeenLastCalledWith(JSON.stringify(["user-a", "company-a"]), [image], []);
  });
});
