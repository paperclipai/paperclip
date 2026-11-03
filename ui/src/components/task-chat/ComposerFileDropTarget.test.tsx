// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerFileDropTarget } from "./ComposerFileDropTarget";

let host: HTMLDivElement;
let root: Root;
const file = new File(["image"], "screenshot.png", { type: "image/png" });
function render(content: ReactElement) { act(() => root.render(content)); }
function drag(type: string, target: EventTarget = document.body, types = ["Files"], relatedTarget: EventTarget | null = null) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { types, files: types.includes("Files") ? [file] : [], dropEffect: "none" } },
    relatedTarget: { value: relatedTarget },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}
const overlay = () => document.querySelector('[data-testid="composer-file-drop-overlay"]');
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

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
      {open ? <div role="dialog"><ComposerFileDropTarget newTask enabled={enabled} onFiles={newFiles} /></div> : null}
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
    render(<><ComposerFileDropTarget enabled onFiles={onFiles} /><div role="dialog">Settings</div></>);
    drag("dragenter"); drag("drop");
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
