import { useState } from "react";
import { Button } from "@/components/ui/button";

const chapters = [
  { title: "Start inside Paperclip", place: "Paperclip → Connectors", action: "You are already in your organization. Open Connectors in the sidebar and find Assistant Connection (MCP). Click Set up.", result: "This connects an outside assistant to Paperclip using your human account. There is no agent picker.", story: "assistant-connections-start-here--connections" },
  { title: "Enable the experiment", place: "Setup → Experimental settings → Setup", action: "When access is off, follow Open Experimental settings. Enable Assistant connections (MCP), then use the Set up an assistant connection link beside the setting to return.", result: "Enabling makes connection setup available. No assistant is authorized yet.", story: "assistant-connections-start-here--enable-setup" },
  { title: "Copy an invitation", place: "Paperclip → Assistant Connection → your assistant", action: "Click Copy invitation and paste the message into OpenCode, Codex, or Claude. The assistant reads the public setup instructions, checks existing configuration, and starts sign-in. Manual commands remain under Set up manually.", result: "The link contains instructions, not a credential. You approve access when the identified client connects. Storybook does not configure a real assistant.", story: "assistant-connections-start-here--open-code-setup" },
  { title: "Approve your organization", place: "Browser sign-in → Paperclip consent", action: "Sign in if needed, select your organization, review write access, and click Connect organization. The browser returns authorization to OpenCode. The preview below is a fixture and issues no credentials.", result: "The grant uses your permissions in this organization. Selecting an agent to receive work later does not change your identity.", story: "assistant-connections-consent--open-code-organization" },
  { title: "Review your organization in OpenCode", place: "Terminal → opencode web → new conversation", action: "After sign-in completes, start opencode web in the same directory. Ask which Paperclip organization is connected and which agents and tasks it has.", result: "The assistant should read live organization and agent data before suggesting an assignee.", scene: ["Example request: “Which Paperclip organization am I connected to? Show me its agents and open tasks.”", "Expected behavior: use the connection, agent-list, and task-search tools. This is an example, not a captured OpenCode response."] },
  { title: "Delegate a task", place: "OpenCode → Paperclip task", action: "Ask an available agent to produce a small result, such as three names for a neighborhood plant nursery. Ask for the task link.", result: "One durable task is created as you. Paperclip schedules the agent with its configured credentials, environment, budget, and approvals. A created task is not proof that work has completed.", scene: ["Example request: “Have our researcher propose three nursery names, explain each briefly, and save a report on the task.”", "Expected behavior: return a durable task reference and disclose the scheduling effect. No task is created by this Storybook panel."] },
  { title: "Return for results and feedback", place: "A later OpenCode conversation", action: "Open a new conversation, find the task, and ask for its saved report. Add feedback as yourself if write access was approved.", result: "The task and report persist outside the original chat. Feedback can wake the agent and use the organization’s execution budget.", scene: ["Example request: “Find my nursery naming task and summarize the completed report.”", "Example feedback: “Add my comment: Meadow & Root is my favorite.”", "Expected behavior: read current progress and the stored document, then attribute any requested comment to the connected person. These are illustrative prompts, not live results."] },
  { title: "Return to Connections", place: "Paperclip → Connectors → Assistant Connection (MCP)", action: "Open the same catalog entry to inspect your connected assistants and their read/write access. Revoke OpenCode if you want to stop future calls.", result: "The list shows your actual grants for the selected organization. Revocation does not cancel work already delegated. This checkpoint uses sample grant data.", story: "assistant-connections-start-here--connected" },
];

/** Presenter controls stay outside the actual product iframe. */
export function PublicMcpPresenter() {
  const [index, setIndex] = useState(0);
  const chapter = chapters[index]!;
  return <main className="space-y-5 p-5" aria-label="Assistant connection guided walkthrough">
    <header className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">STORYBOOK WALKTHROUGH · SAMPLE DATA</p>
      <h1 className="text-xl font-semibold">Start in Paperclip. Bring your organization into your assistant.</h1>
      <p className="text-sm text-muted-foreground">Click through the real product screens below. Presenter chapters explain the terminal and assistant handoffs; they do not simulate live OAuth or model execution.</p>
    </header>
    <nav aria-label="Journey chapters" className="flex flex-wrap gap-2">{chapters.map((item, n) => <Button key={item.title} size="sm" variant={n === index ? "secondary" : "ghost"} aria-current={n === index ? "step" : undefined} onClick={() => setIndex(n)}>{n + 1}. {item.title}</Button>)}</nav>
    <section className="space-y-2 rounded-lg border border-border p-4" aria-live="polite">
      <p className="text-xs text-muted-foreground">{chapter.place}</p>
      <h2 className="text-lg font-semibold">{index + 1}. {chapter.title}</h2>
      <p className="text-sm">{chapter.action}</p>
      <p className="text-sm text-muted-foreground">{chapter.result}</p>
      <nav aria-label="Walkthrough controls" className="flex items-center justify-between gap-3 pt-3">
        <Button variant="outline" disabled={index === 0} onClick={() => setIndex(n => n - 1)}>Previous chapter</Button>
        <span className="text-xs text-muted-foreground">{index + 1} / {chapters.length}</span>
        <Button onClick={() => setIndex(n => n === chapters.length - 1 ? 0 : n + 1)}>{index === chapters.length - 1 ? "Restart walkthrough" : "Next chapter"}</Button>
      </nav>
    </section>
    {chapter.story ? <iframe key={chapter.story} className="h-screen w-full rounded-lg border border-border" src={`./iframe.html?id=${chapter.story}&viewMode=story&globals=theme:dark`} title={`${chapter.title} — real product screen with mocked services`} />
      : <section className="space-y-4 rounded-lg border border-border p-6"><p className="text-xs font-medium text-muted-foreground">ILLUSTRATIVE CONVERSATION · NO LIVE EXECUTION</p>{chapter.scene?.map(text => <p className="text-sm" key={text}>{text}</p>)}</section>}
  </main>;
}
