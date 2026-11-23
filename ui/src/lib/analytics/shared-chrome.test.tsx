// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { Bot } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/EmptyState";
import { ANALYTICS_MASK_TEXT_SELECTOR } from "./privacy";

function textOf(html: string, text: string): string {
  document.body.innerHTML = html;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent === text) {
      return walker.currentNode.parentElement?.closest(ANALYTICS_MASK_TEXT_SELECTOR) ? text.replace(/\S/g, "*") : text;
    }
  }
  throw new Error(`text not rendered: ${text}`);
}

describe("shared components and session replay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("records the text of shared components as it is", () => {
    const html = renderToStaticMarkup(
      <div>
        <Button>New task</Button>
        <Label>Agent name</Label>
        <Tabs><TabsList><TabsTrigger value="a">Activity</TabsTrigger></TabsList></Tabs>
        <EmptyState icon={Bot} message="Inbox zero." />
      </div>,
    );
    expect(textOf(html, "New task")).toBe("New task");
    expect(textOf(html, "Agent name")).toBe("Agent name");
    expect(textOf(html, "Activity")).toBe("Activity");
    expect(textOf(html, "Inbox zero.")).toBe("Inbox zero.");
  });
});
