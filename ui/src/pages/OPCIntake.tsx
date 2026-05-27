import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OPCBlueprint, OPCProposalDetail, ProposalSourceType } from "@paperclipai/shared";
import {
  Building2,
  CheckCircle2,
  FileText,
  Lightbulb,
  MessageSquare,
  FolderGit2,
  Rocket,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { opcApi } from "../api/opc";
import { queryKeys } from "../lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MarkdownBody } from "../components/MarkdownBody";

type CoachMessage = {
  role: "founder" | "coach";
  content: string;
};

function sourceTypeFromFile(file: File): ProposalSourceType {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return "txt";
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file"));
    reader.readAsDataURL(file);
  });
}

function blueprintMarkdown(blueprint: OPCBlueprint) {
  return [
    `### Vision\n${blueprint.summary}`,
    `### Wedge MVP\n${blueprint.mvpWedge}`,
    `### Target Customer\n${blueprint.targetCustomer}`,
    `### UX Direction\n${blueprint.uxNotes}`,
    `### Architecture\n${blueprint.architectureNotes}`,
    `### Risks\n${blueprint.risks.map((risk) => `- ${risk}`).join("\n")}`,
    `### Launch Plan\n${blueprint.launchPlan.map((step) => `- ${step}`).join("\n")}`,
  ].join("\n\n");
}

function statusLabel(status: OPCBlueprint["status"] | undefined) {
  if (status === "company_created") return "Company created";
  if (status === "approved") return "Approved";
  return "Draft";
}

export function OPCIntake() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [proposalText, setProposalText] = useState("");
  const [proposalName, setProposalName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectLink, setProjectLink] = useState("");
  const [projectMode, setProjectMode] = useState<"advise" | "take_charge">("advise");
  const [file, setFile] = useState<File | null>(null);
  const [detail, setDetail] = useState<OPCProposalDetail | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [companyName, setCompanyName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "OPC Intake" }]);
  }, [setBreadcrumbs]);

  const blueprint = detail?.blueprint ?? null;
  const canApprove = Boolean(blueprint && blueprint.status === "draft");
  const canCreateCompany = Boolean(blueprint && blueprint.status === "approved");
  const createdCompanyId = blueprint?.createdCompanyId ?? detail?.proposal.createdCompanyId ?? null;

  const createProposal = useMutation({
    mutationFn: async () => {
      const trimmedText = proposalText.trim();
      const projectPayload = {
        projectPath: projectPath.trim() || undefined,
        projectLink: projectLink.trim() || undefined,
        projectMode,
      };
      if (file) {
        const sourceType = sourceTypeFromFile(file);
        const fileContentBase64 = await readFileAsBase64(file);
        return opcApi.createProposal({
          text: trimmedText || undefined,
          sourceType,
          filename: file.name,
          mimeType: file.type || null,
          fileContentBase64,
          ...projectPayload,
        });
      }
      return opcApi.createProposal({
        text: trimmedText || undefined,
        sourceType: "paste",
        ...projectPayload,
      });
    },
    onSuccess: (result) => {
      setDetail(result);
      setMessages([
        {
          role: "coach",
          content: "I drafted the first OPC blueprint. Tighten customer, scope, and approval assumptions before creating the company.",
        },
      ]);
      if (!companyName.trim()) {
        setCompanyName(proposalName.trim() || "");
      }
    },
  });

  const chat = useMutation({
    mutationFn: (message: string) => opcApi.chat(detail!.proposal.id, { message }),
    onSuccess: (result, message) => {
      setMessages((current) => [
        ...current,
        { role: "founder", content: message },
        { role: "coach", content: result.response },
      ]);
      setDetail((current) => current ? { ...current, blueprint: result.blueprint } : current);
      setChatInput("");
    },
  });

  const approve = useMutation({
    mutationFn: () => opcApi.approveBlueprint(detail!.proposal.id),
    onSuccess: (updated) => {
      setDetail((current) => current ? { ...current, blueprint: updated } : current);
      setMessages((current) => [...current, { role: "coach", content: "Blueprint approved. The next step will create the Paperclip company, org chart, issues, and routines." }]);
    },
  });

  const createCompany = useMutation({
    mutationFn: () => opcApi.createCompany(detail!.proposal.id, {
      name: companyName.trim() || undefined,
      adapterType: "process",
      adapterConfig: projectMode === "take_charge" && projectPath.trim() ? { cwd: projectPath.trim() } : {},
      projectPath: projectPath.trim() || undefined,
      projectLink: projectLink.trim() || undefined,
      projectMode,
    }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      setSelectedCompanyId(result.company.id, { source: "manual" });
      navigate(`/${result.company.issuePrefix}/dashboard`);
    },
  });

  const blueprintPreview = useMemo(
    () => blueprint ? blueprintMarkdown(blueprint) : "",
    [blueprint],
  );

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">OPC Intake</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Turn a proposal into a challenged blueprint, then create a Paperclip company with agents, work, and routines.
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">
          <Building2 className="h-3.5 w-3.5" />
          {statusLabel(blueprint?.status)}
        </Badge>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(480px,1.1fr)]">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Proposal</h2>
          </div>
          <div className="space-y-3">
            <Input
              value={proposalName}
              onChange={(event) => setProposalName(event.target.value)}
              placeholder="Optional company name"
            />
            <div className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <FolderGit2 className="h-4 w-4 text-muted-foreground" />
                <div className="text-sm font-medium">Current project</div>
              </div>
              <div className="space-y-2">
                <Input
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder="/Users/match/path/to/current-project"
                />
                <Input
                  value={projectLink}
                  onChange={(event) => setProjectLink(event.target.value)}
                  placeholder="https://github.com/name/repo or live app link"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={projectMode === "advise" ? "default" : "outline"}
                    onClick={() => setProjectMode("advise")}
                    className="justify-center"
                  >
                    Advise only
                  </Button>
                  <Button
                    type="button"
                    variant={projectMode === "take_charge" ? "default" : "outline"}
                    onClick={() => setProjectMode("take_charge")}
                    className="justify-center"
                  >
                    Take charge
                  </Button>
                </div>
              </div>
            </div>
            <Textarea
              value={proposalText}
              onChange={(event) => setProposalText(event.target.value)}
              placeholder="Paste the proposal, product brief, or founder notes. If you only enter a project path/link, OPC will start from that current project context."
              className="min-h-64 resize-y"
            />
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent/40">
              <span className="flex min-w-0 items-center gap-2">
                <Upload className="h-4 w-4 shrink-0" />
                <span className="truncate">{file ? file.name : "Upload .pdf, .docx, .txt, or .md"}</span>
              </span>
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md,text/plain,text/markdown,application/pdf"
                className="hidden"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {createProposal.error ? (
              <p className="text-sm text-destructive">{createProposal.error.message}</p>
            ) : null}
            <Button
              onClick={() => createProposal.mutate()}
              disabled={createProposal.isPending || (!proposalText.trim() && !file && !projectPath.trim() && !projectLink.trim())}
              className="w-full justify-center"
            >
              <Lightbulb className="mr-2 h-4 w-4" />
              {createProposal.isPending ? "Analyzing..." : "Analyze Project"}
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Coach Mode</h2>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => approve.mutate()} disabled={!canApprove || approve.isPending}>
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" onClick={() => createCompany.mutate()} disabled={!canCreateCompany || createCompany.isPending}>
                <Rocket className="mr-1.5 h-3.5 w-3.5" />
                Create OPC Company
              </Button>
            </div>
          </div>

          {blueprint ? (
            <div className="grid gap-4 lg:grid-cols-[1fr_0.85fr]">
              <div className="min-w-0 rounded-md border border-border p-3">
                <MarkdownBody className="prose-sm max-w-none" softBreaks>
                  {blueprintPreview}
                </MarkdownBody>
              </div>
              <div className="flex min-h-0 flex-col gap-3">
                <div className="rounded-md border border-border p-3">
                  <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Agent org</div>
                  <div className="space-y-2">
                    {blueprint.agentPlan.map((agent) => (
                      <div key={`${agent.name}-${agent.role}`} className="flex items-start justify-between gap-2 text-sm">
                        <span className="font-medium">{agent.name}</span>
                        <span className="text-xs text-muted-foreground">{agent.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Operating loops</div>
                  <div className="space-y-2">
                    {blueprint.routinePlan.map((routine) => (
                      <div key={routine.title} className="flex items-start gap-2 text-sm">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>{routine.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
              Paste or upload a proposal to start the coach review.
            </div>
          )}

          {detail ? (
            <div className="mt-4 space-y-3">
              <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-3">
                {messages.map((message, index) => (
                  <div key={index} className={message.role === "coach" ? "text-sm" : "text-sm text-muted-foreground"}>
                    <span className="font-medium">{message.role === "coach" ? "Coach" : "Founder"}: </span>
                    <span className="whitespace-pre-wrap">{message.content}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Ask for a scope, design, engineering, QA, or launch critique"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && chatInput.trim() && !chat.isPending) {
                      chat.mutate(chatInput.trim());
                    }
                  }}
                />
                <Button onClick={() => chat.mutate(chatInput.trim())} disabled={!chatInput.trim() || chat.isPending}>
                  Send
                </Button>
              </div>
              <Input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                placeholder="Company name for creation"
              />
              {approve.error || createCompany.error || chat.error ? (
                <p className="text-sm text-destructive">
                  {(approve.error || createCompany.error || chat.error)?.message}
                </p>
              ) : null}
              {createdCompanyId ? (
                <p className="text-sm text-muted-foreground">Company already created for this blueprint.</p>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
