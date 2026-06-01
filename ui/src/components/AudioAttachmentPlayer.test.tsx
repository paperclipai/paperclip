// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueAttachment } from "@paperclipai/shared";
import { AudioAttachmentPlayer } from "./AudioAttachmentPlayer";
import { resetAudioPlaybackCoordinatorForTests } from "@/lib/audio-playback-coordinator";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createAudioAttachment(overrides: Partial<IssueAttachment> = {}): IssueAttachment {
  return {
    id: "attachment-audio-1",
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "audio-1",
    provider: "local",
    objectKey: "audio-1",
    originalFilename: "briefing.mp3",
    contentPath: "/api/assets/audio-1/content",
    contentType: "audio/mpeg",
    byteSize: 2048,
    sha256: "abc",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-05-27T00:00:00.000Z"),
    updatedAt: new Date("2026-05-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("AudioAttachmentPlayer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    resetAudioPlaybackCoordinatorForTests();
  });

  afterEach(() => {
    container.remove();
    resetAudioPlaybackCoordinatorForTests();
  });

  it("renders native audio controls with attachment metadata", () => {
    const root = createRoot(container);
    const attachment = createAudioAttachment();

    act(() => {
      root.render(<AudioAttachmentPlayer attachment={attachment} />);
    });

    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute("src")).toBe(attachment.contentPath);
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(container.textContent).toContain("briefing.mp3");
    expect(container.textContent).toContain("audio/mpeg");
  });

  it("pauses another player when a second attachment starts playing", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <div>
          <AudioAttachmentPlayer attachment={createAudioAttachment({ id: "a1", assetId: "a1" })} />
          <AudioAttachmentPlayer
            attachment={createAudioAttachment({
              id: "a2",
              assetId: "a2",
              originalFilename: "second.mp3",
              contentPath: "/api/assets/audio-2/content",
            })}
          />
        </div>,
      );
    });

    const [first, second] = Array.from(container.querySelectorAll("audio"));
    const pauseFirst = vi.spyOn(first, "pause");
    Object.defineProperty(first, "paused", { configurable: true, get: () => false });

    act(() => {
      first.dispatchEvent(new Event("play"));
    });
    act(() => {
      second.dispatchEvent(new Event("play"));
    });

    expect(pauseFirst).toHaveBeenCalledTimes(1);
  });
});
