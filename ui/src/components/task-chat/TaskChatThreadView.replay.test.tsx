// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { REPLAY_WORK_CONTENT_ATTRIBUTE } from "@/lib/analytics/privacy";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";
import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatItem } from "./task-chat-model";

const items: TaskChatItem[] = [
  { id: "brief", kind: "brief" },
  { id: "failed", kind: "marker", variant: "interrupted", label: "Pulled the Globex inbox thread" },
];

function render(replayMask: boolean) {
  document.body.innerHTML = renderToStaticMarkup(
    <TaskChatThreadView
      items={items}
      scroll={false}
      replayMask={replayMask}
      header={<p>Header from Slack</p>}
      renderBrief={() => <p>Ship the Q3 launch plan</p>}
      tail={<p>Live tail output</p>}
    />,
  );
}

describe("TaskChatThreadView session replay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE);
  });

  it("masks every row, the header and the tail, and masks the description by default", () => {
    render(true);
    expect(replayLeaks("Ship the Q3 launch plan")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Pulled the Globex inbox thread")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Header from Slack")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Live tail output")).toEqual({ rendered: true, recorded: false });
  });

  it("shows only the description when the company holds no Google or Slack data", () => {
    document.documentElement.setAttribute(REPLAY_WORK_CONTENT_ATTRIBUTE, "visible");
    render(true);
    expect(replayLeaks("Ship the Q3 launch plan")).toEqual({ rendered: true, recorded: true });
    expect(replayLeaks("Pulled the Globex inbox thread")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Header from Slack")).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Live tail output")).toEqual({ rendered: true, recorded: false });
  });
});
