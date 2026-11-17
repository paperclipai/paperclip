// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { Bot } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/EmptyState";
import { ANALYTICS_UNMASK_ATTRIBUTE, maskReplayText } from "./privacy";

// Shared components render customer text too (agent names, document titles),
// so none of them reveals replay text unless its caller opts in.

function textOf(html: string, text: string): string {
  document.body.innerHTML = html;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent === text) return maskReplayText(text, walker.currentNode.parentElement);
  }
  throw new Error(`text not rendered: ${text}`);
}

describe("shared components and session replay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("masks customer text in shared components by default", () => {
    const html = renderToStaticMarkup(
      <div>
        <Button>Open Acme Plan</Button>
        <Label>Ada Agent</Label>
        <Tabs><TabsList><TabsTrigger value="a">Q3 Board Deck</TabsTrigger></TabsList></Tabs>
        <EmptyState icon={Bot} message="No costs for Ada Agent yet." />
      </div>,
    );
    expect(html).not.toContain(ANALYTICS_UNMASK_ATTRIBUTE);
    expect(textOf(html, "Open Acme Plan")).toBe("**** **** ****");
    expect(textOf(html, "Ada Agent")).toBe("*** *****");
    expect(textOf(html, "Q3 Board Deck")).toBe("** ***** ****");
    expect(textOf(html, "No costs for Ada Agent yet.")).toBe("** ***** *** *** ***** ****");
  });

  it("shows fixed product copy when the caller opts in", () => {
    const html = renderToStaticMarkup(
      <div>
        <Button analyticsChrome>New task</Button>
        <Label analyticsChrome>Agent name</Label>
        <Tabs><TabsList><TabsTrigger analyticsChrome value="a">Activity</TabsTrigger></TabsList></Tabs>
        <EmptyState analyticsChrome icon={Bot} message="Inbox zero." />
      </div>,
    );
    expect(textOf(html, "New task")).toBe("New task");
    expect(textOf(html, "Agent name")).toBe("Agent name");
    expect(textOf(html, "Activity")).toBe("Activity");
    expect(textOf(html, "Inbox zero.")).toBe("Inbox zero.");
  });
});
