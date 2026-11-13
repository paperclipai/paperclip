import type { TaskChatEvidence } from "./task-chat.js";

const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderTaskChat(evidence?: TaskChatEvidence) {
  if (!evidence || (!evidence.threads.length && evidence.status === "complete")) return "";
  return `<section class="task-chat-recording" aria-label="Task chat">
    <h4>Task chat</h4>
    ${evidence.status !== "complete" ? `<p class="detail">Conversation capture ${html(evidence.status)}. Some task history could not be collected (${evidence.missing.map(html).join(", ")}).</p>` : ""}
    ${evidence.threads.map(thread => `<details class="case-context conversation-details"${evidence.threads.length === 1 ? " open" : ""}>
      <summary>${html(thread.identifier ? `${thread.identifier}: ` : "")}${html(thread.title)} · ${thread.messages.length} entries${thread.status === "partial" ? " · partial capture" : ""}</summary>
      <section class="transcript" aria-label="Conversation for ${html(thread.title)}">
        <p class="transcript-about">Recorded task brief, messages, requests and answers, with native agent progress when available. This is a read-only recording of the saved task conversation.</p>
        ${thread.messages.length ? thread.messages.map(message => `<article class="transcript-entry ${message.role === "user" ? "transcript-human" : "transcript-agent"}${message.kind === "interaction" ? " transcript-card" : ""}">
          <header><strong>${html(message.author)}</strong>${message.kind === "answer" ? "<span>Response</span>" : ""}</header>
          <div class="transcript-bubble"><div class="transcript-text">${html(message.body)}</div></div>
          ${message.at ? `<footer><time datetime="${html(message.at)}">${html(message.at)}</time></footer>` : ""}
        </article>`).join("") : '<p class="detail">No messages were saved on this task.</p>'}
      </section>
    </details>`).join("")}
  </section>`;
}
