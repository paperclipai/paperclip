import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companyEmailApi, type EmailThread, type EmailMessage } from "../api/company-email";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Send,
  Inbox,
  RefreshCw,
  Plus,
  MessageSquare,
  ChevronRight,
  ArrowLeft,
  Paperclip,
} from "lucide-react";

type Tab = "threads" | "messages" | "compose";

export function CommunicationCenter() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("threads");
  const [selectedThread, setSelectedThread] = useState<EmailThread | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Communication Center" }]); }, [setBreadcrumbs]);

  const settingsQ = useQuery({
    queryKey: ["company-email-settings", selectedCompanyId],
    queryFn: () => companyEmailApi.getSettings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const threadsQ = useQuery({
    queryKey: ["company-email-threads", selectedCompanyId],
    queryFn: () => companyEmailApi.listThreads(selectedCompanyId!, 50),
    enabled: !!selectedCompanyId && !!settingsQ.data?.enabled,
  });

  const messagesQ = useQuery({
    queryKey: ["company-email-messages", selectedCompanyId],
    queryFn: () => companyEmailApi.listMessages(selectedCompanyId!, 50),
    enabled: !!selectedCompanyId && !!settingsQ.data?.enabled && tab === "messages",
  });

  const sendMutation = useMutation({
    mutationFn: (data: { to: string; subject: string; text: string }) =>
      companyEmailApi.sendMessage(selectedCompanyId!, data),
    onSuccess: () => {
      pushToast({ title: "Message sent successfully", tone: "success" });
      setComposeOpen(false);
      qc.invalidateQueries({ queryKey: ["company-email-threads", selectedCompanyId] });
      qc.invalidateQueries({ queryKey: ["company-email-messages", selectedCompanyId] });
    },
    onError: (err) => pushToast({ title: `Failed to send: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }),
  });

  const replyMutation = useMutation({
    mutationFn: (data: { messageId: string; text: string }) =>
      companyEmailApi.replyToMessage(selectedCompanyId!, data.messageId, { text: data.text }),
    onSuccess: () => {
      pushToast({ title: "Reply sent", tone: "success" });
      qc.invalidateQueries({ queryKey: ["company-email-threads", selectedCompanyId] });
    },
    onError: (err) => pushToast({ title: `Failed to reply: ${err instanceof Error ? err.message : String(err)}`, tone: "error" }),
  });

  if (!selectedCompanyId) return null;

  const settings = settingsQ.data;
  const notConfigured = !settings?.enabled || !settings?.agentmailEmail;

  if (notConfigured) {
    return (
      <div className="mx-auto max-w-2xl py-12 text-center">
        <Mail className="mx-auto h-12 w-12 text-muted-foreground/50" />
        <h2 className="mt-4 text-lg font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">Communication Center</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Email is not configured yet. Go to{" "}
          <a href="/company/settings" className="text-primary underline">
            Company Settings
          </a>{" "}
          to set up your AgentMail API key and create an inbox.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2 font-[var(--font-display)] uppercase tracking-[0.06em]">
            <Mail className="h-5 w-5" />
            Communication Center
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {settings.agentmailEmail}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["company-email-threads", selectedCompanyId] });
              qc.invalidateQueries({ queryKey: ["company-email-messages", selectedCompanyId] });
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setComposeOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Compose
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        <button
          className={`px-3 py-1.5 text-sm font-medium border-b-2 ${
            tab === "threads"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => { setTab("threads"); setSelectedThread(null); }}
        >
          <MessageSquare className="h-3.5 w-3.5 inline mr-1" />
          Threads
        </button>
        <button
          className={`px-3 py-1.5 text-sm font-medium border-b-2 ${
            tab === "messages"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setTab("messages")}
        >
          <Inbox className="h-3.5 w-3.5 inline mr-1" />
          All Messages
        </button>
      </div>

      {/* Compose Modal */}
      {composeOpen && (
        <ComposeForm
          onSend={(data) => sendMutation.mutate(data)}
          onCancel={() => setComposeOpen(false)}
          sending={sendMutation.isPending}
        />
      )}

      {/* Thread Detail */}
      {selectedThread && (
        <ThreadDetail
          thread={selectedThread}
          companyId={selectedCompanyId}
          onBack={() => setSelectedThread(null)}
          onReply={(messageId, text) => replyMutation.mutate({ messageId, text })}
          replying={replyMutation.isPending}
        />
      )}

      {/* Thread List */}
      {tab === "threads" && !selectedThread && (
        <div className="space-y-1">
          {threadsQ.isLoading && (
            <p className="text-sm text-muted-foreground py-8 text-center">Loading threads...</p>
          )}
          {threadsQ.data?.threads?.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">No threads yet. Send your first email!</p>
          )}
          {threadsQ.data?.threads?.map((thread) => (
            <button
              key={thread.thread_id}
              onClick={() => setSelectedThread(thread)}
              className="w-full text-left px-3 py-2.5 rounded-[2px] border border-border hover:bg-[var(--sidebar-accent)] transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{thread.subject || "(no subject)"}</span>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px]">
                    {thread.message_count} msg{thread.message_count !== 1 ? "s" : ""}
                  </Badge>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {new Date(thread.updated_at).toLocaleString()}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Messages List */}
      {tab === "messages" && (
        <div className="space-y-1">
          {messagesQ.isLoading && (
            <p className="text-sm text-muted-foreground py-8 text-center">Loading messages...</p>
          )}
          {messagesQ.data?.messages?.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">No messages yet.</p>
          )}
          {messagesQ.data?.messages?.map((msg) => (
            <MessageRow key={msg.message_id} message={msg} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ComposeForm({
  onSend,
  onCancel,
  sending,
}: {
  onSend: (data: { to: string; subject: string; text: string }) => void;
  onCancel: () => void;
  sending: boolean;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");

  return (
    <div className="rounded-[2px] border border-border p-4 space-y-3 bg-card hud-panel hud-shimmer">
      <h3 className="text-sm font-semibold flex items-center gap-1.5 font-[var(--font-display)] uppercase tracking-[0.06em]">
        <Send className="h-3.5 w-3.5" /> New Message
      </h3>
      <input
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
        placeholder="To (email address)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm"
        placeholder="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm min-h-[120px]"
        placeholder="Message body..."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!to || !subject || sending}
          onClick={() => onSend({ to, subject, text })}
        >
          {sending ? "Sending..." : "Send"}
        </Button>
      </div>
    </div>
  );
}

function ThreadDetail({
  thread,
  companyId,
  onBack,
  onReply,
  replying,
}: {
  thread: EmailThread;
  companyId: string;
  onBack: () => void;
  onReply: (messageId: string, text: string) => void;
  replying: boolean;
}) {
  const [replyText, setReplyText] = useState("");

  // Fetch the full thread detail (with messages) from the API
  const threadDetailQ = useQuery({
    queryKey: ["company-email-thread-detail", companyId, thread.thread_id],
    queryFn: () => companyEmailApi.getThread(companyId, thread.thread_id),
    enabled: !!thread.thread_id,
  });

  const messages = threadDetailQ.data?.messages ?? thread.messages ?? [];
  const lastMessage = messages[messages.length - 1];

  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to threads
      </button>
      <h2 className="text-sm font-semibold">{thread.subject || "(no subject)"}</h2>

      {threadDetailQ.isLoading && (
        <p className="text-sm text-muted-foreground py-4 text-center">Loading messages...</p>
      )}
      {threadDetailQ.error && (
        <p className="text-sm text-destructive py-2">
          Failed to load thread: {threadDetailQ.error instanceof Error ? threadDetailQ.error.message : String(threadDetailQ.error)}
        </p>
      )}

      <div className="space-y-2">
        {messages.map((msg) => (
          <div key={msg.message_id} className="rounded-[2px] border border-border p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium">{msg.from_}</span>
              <span className="text-[10px] text-muted-foreground">
                {new Date(msg.created_at).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
              <span>To: {msg.to?.join(", ")}</span>
              {msg.cc && msg.cc.length > 0 && <span>CC: {msg.cc.join(", ")}</span>}
            </div>
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {msg.attachments.map((att) => (
                  <Badge key={att.attachment_id} variant="outline" className="text-[10px]">
                    <Paperclip className="h-2.5 w-2.5 mr-0.5" />
                    {att.filename} ({(att.size / 1024).toFixed(1)}KB)
                  </Badge>
                ))}
              </div>
            )}
            {/* Show HTML content if available, otherwise plain text */}
            {msg.html ? (
              <div
                className="text-sm prose prose-sm dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: msg.html }}
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{msg.text || "(no text content)"}</p>
            )}
          </div>
        ))}
      </div>

      {messages.length === 0 && !threadDetailQ.isLoading && (
        <p className="text-sm text-muted-foreground py-4 text-center">No messages in this thread.</p>
      )}

      {lastMessage && (
        <div className="flex gap-2">
          <textarea
            className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm min-h-[60px]"
            placeholder="Reply..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
          />
          <Button
            size="sm"
            className="self-end"
            disabled={!replyText || replying}
            onClick={() => {
              onReply(lastMessage.message_id, replyText);
              setReplyText("");
            }}
          >
            {replying ? "..." : "Reply"}
          </Button>
        </div>
      )}
    </div>
  );
}

function MessageRow({ message }: { message: EmailMessage }) {
  return (
    <div className="px-3 py-2.5 rounded-[2px] border border-border">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium truncate">{message.subject || "(no subject)"}</span>
        <span className="text-[10px] text-muted-foreground">
          {new Date(message.created_at).toLocaleString()}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5">
        From: {message.from_} &rarr; To: {message.to?.join(", ")}
      </p>
      {message.text && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{message.text}</p>
      )}
    </div>
  );
}
