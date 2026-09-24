import { useState } from "react";
import { ChatCommunicationInstructions } from "@/pages/apps/chat/ChatCommunicationInstructions";
import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SlackAvatarSettings } from "@/pages/apps/chat/SlackAvatarStep";
import avatar from "./ceo-cliptoon.png";

export function SlackAvatarSettingsPreview({ initialInstructions = "", failFirstSave = false }: { initialInstructions?: string; failFirstSave?: boolean }) {
  const [instructions, setInstructions] = useState(initialInstructions);
  const [failSave, setFailSave] = useState(failFirstSave);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex gap-3 border-b border-border px-6 py-4 text-sm">
        <span className="text-muted-foreground">Connectors /</span>CEO · Slack
      </header>
      <div className="flex flex-col md:flex-row">
        <aside className="flex shrink-0 gap-2 border-b border-border p-4 md:w-60 md:flex-col md:border-r md:border-b-0">
          {["Settings", "Access", "Conversations", "Activity"].map((tab) => (
            <span
              key={tab}
              className={`rounded-md px-3 py-2 text-sm ${tab === "Settings" ? "bg-accent font-medium" : "text-muted-foreground"}`}
            >
              {tab}
            </span>
          ))}
        </aside>
        <main className="min-w-0 flex-1 p-6 md:p-8">
          <div className="max-w-2xl space-y-8">
            <h1 className="text-xl font-bold">CEO in Slack</h1>
            <section className="space-y-2 text-sm">
              <h2 className="text-lg font-semibold">Chat in Slack</h2>
              <p>
                Invite the bot to a channel, then mention it to start a
                conversation.
              </p>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>@ceo you there?</code>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copy message"
                  onClick={() =>
                    void navigator.clipboard.writeText("@ceo you there?")
                  }
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </section>
            <SlackAvatarSettings
              agentName="CEO"
              appName="ceo-paperclip"
              avatarUrl={avatar}
            />
            <ChatCommunicationInstructions value={instructions} onSave={async (next) => {
              if (failSave) { setFailSave(false); throw new Error("Couldn’t save instructions. Try again."); }
              setInstructions(next);
            }} />
            <section className="space-y-4">
              <h2 className="text-lg font-semibold">
                Where this agent can work
              </h2>
              <h3 className="text-sm font-semibold">Allowed Channels</h3>
              <div className="border-y border-border py-3 text-sm">
                #general{" "}
                <ExternalLink className="inline size-3 text-muted-foreground" />
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
