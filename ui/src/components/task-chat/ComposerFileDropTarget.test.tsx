// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "../MarkdownEditor";
import { IssueAttachmentsSection } from "../IssueAttachmentsSection";
import { ArtifactDropzone } from "../artifacts/ArtifactDropzone";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { ComposerFileDropTarget } from "./ComposerFileDropTarget";

let host: HTMLDivElement;
let root: Root;
const file = new File(["image"], "screenshot.png", { type: "image/png" });
function render(content: ReactElement) { act(() => root.render(content)); }
function drag(type: string, target: EventTarget = document.body, types = ["Files"], relatedTarget: EventTarget | null = null) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { types, files: types.includes("Files") ? [file] : [], items: types.includes("Files") ? [{ kind: "file", type: file.type, getAsFile: () => file }] : [], dropEffect: "none" } },
    relatedTarget: { value: relatedTarget },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}
const overlay = () => document.querySelector('[data-testid="composer-file-drop-overlay"]');
beforeEach(() => { vi.stubGlobal("DragEvent", MouseEvent); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("composer screen file drops", () => {
  it("accepts a drop outside the composer exactly once and clears the overlay", () => {
    const onFiles = vi.fn();
    render(<ComposerFileDropTarget enabled onFiles={onFiles} />);
    expect(drag("dragenter").defaultPrevented).toBe(true);
    expect(overlay()?.textContent).toContain("Drop files to attach");
    expect(drag("dragover").defaultPrevented).toBe(true);
    const downstream = vi.fn();
    document.body.addEventListener("drop", downstream, { once: true });
    expect(drag("drop").defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(downstream).not.toHaveBeenCalled();
    document.body.removeEventListener("drop", downstream);
    expect(overlay()).toBeNull();
  });

  it("keeps the overlay while moving between children, then clears on exit or cancellation", () => {
    render(<ComposerFileDropTarget enabled onFiles={vi.fn()} />);
    drag("dragenter"); drag("dragenter", host); drag("dragleave", document.body, ["Files"], host);
    expect(overlay()).not.toBeNull();
    drag("dragleave", host);
    expect(overlay()).toBeNull();
    for (const cancel of ["dragend", "blur"]) {
      drag("dragenter");
      act(() => { window.dispatchEvent(new Event(cancel)); });
      expect(overlay()).toBeNull();
    }
  });

  it("clears a nested drag when the pointer leaves the window", () => {
    render(<ComposerFileDropTarget enabled onFiles={vi.fn()} />);
    drag("dragenter"); drag("dragenter", host);
    drag("dragleave", document.documentElement);
    expect(overlay()).toBeNull();
  });

  it("preserves description editor file uploads and clears both overlays", async () => {
    const onFiles = vi.fn(); const onDropFile = vi.fn().mockResolvedValue(undefined);
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} />
      <MarkdownEditor value="Description" onChange={vi.fn()} onDropFile={onDropFile} />
    </>);
    const editor = host.querySelector('[contenteditable="true"]')!;
    expect(editor).not.toBeNull();
    drag("dragenter"); expect(overlay()).not.toBeNull();
    drag("dragenter", editor); drag("dragover", editor);
    expect(overlay()).toBeNull();
    expect(host.textContent).toContain("Drop file to upload");
    const attachment = new File(["notes"], "notes.txt", { type: "text/plain" });
    const event = new MouseEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [attachment] } });
    await act(async () => { editor.dispatchEvent(event); });
    expect(onDropFile).toHaveBeenCalledExactlyOnceWith(attachment);
    expect(onFiles).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Drop file to upload");
    expect(overlay()).toBeNull();
    drag("drop"); expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it("keeps image drops in the description image plugin", async () => {
    const onFiles = vi.fn();
    const uploadImage = vi.fn().mockResolvedValue("/description-image.png");
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} />
      <MarkdownEditor value="Description" onChange={vi.fn()} imageUploadHandler={uploadImage} />
    </>);
    const editor = host.querySelector('[contenteditable="true"]')!;
    drag("dragenter", editor); expect(overlay()).toBeNull();
    expect(host.textContent).toContain("Drop image to upload");
    await act(async () => { drag("drop", editor); });
    expect(uploadImage).toHaveBeenCalledExactlyOnceWith(file);
    expect(onFiles).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Drop image to upload");
  });

  it.each(["parent", "readOnly"])("leaves %s editor drops with the composer", (mode) => {
    const onFiles = vi.fn(); const onDropFile = vi.fn();
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} />
      <MarkdownEditor value="Description" onChange={vi.fn()} onDropFile={onDropFile}
        readOnly={mode === "readOnly"} fileDropTarget={mode === "parent" ? "parent" : "editor"} />
    </>);
    drag("drop", host.querySelector(".paperclip-mdxeditor-scope")!);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(onDropFile).not.toHaveBeenCalled();
  });

  it("preserves the task attachments section drop handler", () => {
    const onFiles = vi.fn(); const onDrop = vi.fn();
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} />
      <IssueAttachmentsSection attachments={[]} onImageClick={vi.fn()} onDrop={onDrop} />
    </>);
    const label = Array.from(host.querySelectorAll("h3")).find(item => item.textContent === "Attachments")!;
    drag("drop", label);
    expect(onDrop).toHaveBeenCalledOnce(); expect(onFiles).not.toHaveBeenCalled();
  });

  it("ignores text and link drags", () => {
    const onFiles = vi.fn();
    render(<ComposerFileDropTarget enabled onFiles={onFiles} />);
    expect(drag("dragenter", host, ["text/plain", "text/uri-list"]).defaultPrevented).toBe(false);
    expect(drag("drop", host, ["text/plain"]).defaultPrevented).toBe(false);
    expect(overlay()).toBeNull();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("gives the open dialog exclusive ownership and restores the task on close", () => {
    const taskFiles = vi.fn(); const newFiles = vi.fn();
    const content = (open: boolean, enabled = true) => <>
      <ComposerFileDropTarget enabled onFiles={taskFiles} />
      {open ? <Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>New task</DialogTitle><ComposerFileDropTarget newTask enabled={enabled} onFiles={newFiles} /></DialogContent></Dialog> : null}
    </>;
    render(content(true));
    drag("dragenter");
    expect(overlay()?.textContent).toContain("your new task");
    drag("drop");
    expect(newFiles).toHaveBeenCalledExactlyOnceWith([file]);
    expect(taskFiles).not.toHaveBeenCalled();
    render(content(true, false));
    drag("dragenter"); drag("drop");
    expect(overlay()).toBeNull();
    expect(taskFiles).not.toHaveBeenCalled();
    render(content(false));
    drag("drop");
    expect(taskFiles).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it("does not send files to the underlying task while another dialog is open", () => {
    const onFiles = vi.fn();
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} /><Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>Settings</DialogTitle></DialogContent></Dialog></>);
    drag("dragenter"); drag("drop");
    expect(overlay()).toBeNull(); expect(onFiles).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves artifact uploads with an external target: %s", (external) => {
    const onFiles = vi.fn(); const onUpload = vi.fn();
    const frame = document.createElement("div");
    const header = document.createElement("button");
    frame.append(header); document.body.append(frame);
    try {
      render(<><ComposerFileDropTarget enabled onFiles={onFiles} />
        <ArtifactDropzone onUpload={onUpload} target={external ? frame : undefined}><button data-artifact-file>File</button></ArtifactDropzone></>);
      const destination = external ? header : host.querySelector("[data-artifact-file]")!;
      drag("dragenter"); expect(overlay()).not.toBeNull();
      drag("dragenter", destination); drag("dragover", destination);
      expect(overlay()).toBeNull();
      expect(document.querySelector("[data-artifact-drop-overlay]")).not.toBeNull();
      expect(drag("drop", destination).defaultPrevented).toBe(true);
      expect(onUpload).toHaveBeenCalledExactlyOnceWith([file]);
      expect(onFiles).not.toHaveBeenCalled();
      drag("dragenter"); expect(overlay()).not.toBeNull(); drag("drop");
      expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
      render(<div />);
      expect(frame.hasAttribute("data-file-drop-target")).toBe(false);
    } finally { frame.remove(); }
  });

  it("keeps composer drops available while a portaled picker is open", () => {
    const onFiles = vi.fn();
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} />
      <Popover open><PopoverTrigger>Model</PopoverTrigger><PopoverContent>Choose model</PopoverContent></Popover></>);
    const picker = document.querySelector('[data-slot="popover-content"]')!;
    expect(picker.getAttribute("role")).toBe("dialog");
    expect(host.contains(picker)).toBe(false);
    drag("dragenter"); expect(overlay()).not.toBeNull();
    expect(drag("drop", picker).defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it("prevents browser navigation while the new task is read-only", () => {
    const onFiles = vi.fn();
    render(<Dialog open><DialogContent aria-describedby={undefined}><DialogTitle>New task</DialogTitle>
      <ComposerFileDropTarget newTask enabled={false} onFiles={onFiles} />
    </DialogContent></Dialog>);
    expect(drag("dragenter").defaultPrevented).toBe(true);
    expect(drag("dragover").defaultPrevented).toBe(true);
    expect(drag("drop").defaultPrevented).toBe(true);
    expect(overlay()).toBeNull(); expect(onFiles).not.toHaveBeenCalled();
  });

  it("does not accept drops for a concealed composer", () => {
    const onFiles = vi.fn();
    render(<div inert><ComposerFileDropTarget enabled onFiles={onFiles} /></div>);
    drag("dragenter"); drag("drop");
    expect(overlay()).toBeNull(); expect(onFiles).not.toHaveBeenCalled();
  });

  it("uses the latest callback and clears on disable and unmount", () => {
    const previous = vi.fn(); const next = vi.fn();
    render(<ComposerFileDropTarget enabled onFiles={previous} />);
    drag("dragenter");
    render(<ComposerFileDropTarget enabled={false} onFiles={next} />);
    expect(overlay()).toBeNull(); drag("drop");
    render(<ComposerFileDropTarget enabled onFiles={next} />);
    drag("drop");
    expect(next).toHaveBeenCalledExactlyOnceWith([file]); expect(previous).not.toHaveBeenCalled();
    drag("dragenter"); render(<div />);
    expect(overlay()).toBeNull();
    expect(drag("drop").defaultPrevented).toBe(false);
  });
});
