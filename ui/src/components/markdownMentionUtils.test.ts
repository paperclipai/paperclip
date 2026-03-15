import { afterEach, describe, expect, it } from "vitest";
import { detectMention } from "./markdownMentionUtils";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("detectMention", () => {
  it("detects mentions when the caret is inside a text node", () => {
    const container = document.createElement("div");
    container.contentEditable = "true";
    const textNode = document.createTextNode("@alice");
    container.appendChild(textNode);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(textNode, 6);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const state = detectMention(container);
    expect(state).not.toBeNull();
    expect(state?.query).toBe("alice");
    expect(state?.textNode).toBe(textNode);
    expect(state?.atPos).toBe(0);
    expect(state?.endPos).toBe(6);
  });

  it("detects mentions when the caret is anchored on an element node at editor start", () => {
    const container = document.createElement("div");
    container.contentEditable = "true";
    const paragraph = document.createElement("p");
    paragraph.appendChild(document.createTextNode("@alice"));
    container.appendChild(paragraph);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(paragraph, 1);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const state = detectMention(container);
    expect(state).not.toBeNull();
    expect(state?.query).toBe("alice");
    expect(state?.textNode).toBeNull();
    expect(state?.atPos).toBeNull();
    expect(state?.endPos).toBeNull();
  });

  it("does not leak mentions from earlier blocks for text-node carets", () => {
    const container = document.createElement("div");
    container.contentEditable = "true";
    const first = document.createElement("p");
    first.appendChild(document.createTextNode("@alice"));
    const second = document.createElement("p");
    const secondText = document.createTextNode("hello world");
    second.appendChild(secondText);
    container.append(first, second);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(secondText, secondText.textContent!.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(detectMention(container)).toBeNull();
  });

  it("returns null when there is no active mention", () => {
    const container = document.createElement("div");
    container.contentEditable = "true";
    const textNode = document.createTextNode("hello world");
    container.appendChild(textNode);
    document.body.appendChild(container);

    const range = document.createRange();
    range.setStart(textNode, textNode.textContent!.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(detectMention(container)).toBeNull();
  });
});
