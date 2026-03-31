import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Trash2, Pencil } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companyKnowledgeApi } from "../api/companyKnowledge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { Field, ToggleField } from "../components/agent-config-primitives";
import { CompanyKnowledge } from "../api/companyKnowledge";

export function CompanyKnowledgePage() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tier, setTier] = useState<"global" | "team" | "role">("global");
  const [alwaysInject, setAlwaysInject] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Knowledge Base" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const { data: knowledgeList = [], isLoading } = useQuery({
    queryKey: ["companyKnowledge", selectedCompanyId],
    queryFn: () => companyKnowledgeApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: { title: string; content: string; tier: "global" | "team" | "role"; alwaysInject: boolean }) =>
      companyKnowledgeApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companyKnowledge", selectedCompanyId] });
      setEditingId(null);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: string; title: string; content: string; tier: "global" | "team" | "role"; alwaysInject: boolean }) =>
      companyKnowledgeApi.update(selectedCompanyId!, data.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companyKnowledge", selectedCompanyId] });
      setEditingId(null);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companyKnowledgeApi.delete(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["companyKnowledge", selectedCompanyId] });
    },
  });

  function resetForm() {
    setTitle("");
    setContent("");
    setTier("global");
    setAlwaysInject(false);
  }

  function handleEdit(k: CompanyKnowledge) {
    setTitle(k.title);
    setContent(k.content);
    setTier(k.tier as "global" | "team" | "role");
    setAlwaysInject(k.alwaysInject);
    setEditingId(k.id);
  }

  function handleSave() {
    if (editingId === "new") {
      createMutation.mutate({ title, content, tier, alwaysInject });
    } else if (editingId) {
      updateMutation.mutate({ id: editingId, title, content, tier, alwaysInject });
    }
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading knowledge base...</div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Knowledge Base</h1>
        </div>
        {!editingId && (
          <Button size="sm" onClick={() => { resetForm(); setEditingId("new"); }}>
            <Plus className="mr-1.5 h-4 w-4" />
            New Entry
          </Button>
        )}
      </div>

      {editingId && (
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold">{editingId === "new" ? "Create Knowledge Entry" : "Edit Entry"}</h2>
          <div className="space-y-4">
            <Field label="Title" hint="Name of this knowledge piece (e.g. 'Coding Standards')">
              <input
                type="text"
                placeholder="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </Field>

            <Field label="Tier" hint="Scope of this knowledge">
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as "global" | "team" | "role")}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="global">Global (Company-wide)</option>
                <option value="team">Team</option>
                <option value="role">Role</option>
              </select>
            </Field>

            <Field label="Content" hint="The actual corporate context/instructions for the agents.">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
              />
            </Field>

            <ToggleField
              label="Always Inject"
              hint="If enabled, this knowledge is automatically injected into every agent's system prompt. WARNING: Uses more token budget."
              checked={alwaysInject}
              onChange={setAlwaysInject}
            />

            <div className="flex gap-2 justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending || !title || !content}>
                {editingId === "new" ? "Create" : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!editingId && knowledgeList.length === 0 && (
        <EmptyState
          icon={BookOpen}
          message="No Knowledge Entries. Create your first knowledge entry to provide agents with persistent corporate context."
        />
      )}

      {!editingId && knowledgeList.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {knowledgeList.map((k: CompanyKnowledge) => (
            <div key={k.id} className="rounded-lg border border-border bg-card p-4 flex flex-col hover:border-border/80 transition-colors">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-sm truncate pr-2">{k.title}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                      {k.tier}
                    </span>
                    {k.alwaysInject && (
                      <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">
                        Injected
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => handleEdit(k)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => {
                    if (window.confirm("Delete this entry?")) deleteMutation.mutate(k.id);
                  }} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-4 mt-2 font-mono bg-muted/20 p-2 rounded relative group flex-1 whitespace-pre-wrap">
                {k.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
