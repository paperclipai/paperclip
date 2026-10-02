import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { api } from "../../api/client";
import { secretsApi } from "../../api/secrets";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field, ToggleField } from "../../components/agent-config-primitives";
interface Profile {
  id: string; profileKey: string; displayName: string; credentialSecretId: string; enabled: boolean;
  configuration: { environment: { type: "none" | "openai_hosted" } };
}
export function OpenAiManagedProfileField({ value, onSelect }: {
  value: string; onSelect: (profileKey: string, secretId: string, hosted: boolean) => void;
}) {
  const { selectedCompanyId: companyId } = useCompany();
  const cache = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [hosted, setHosted] = useState(false);
  const [retention, setRetention] = useState(false);
  const queryKey = ["openai-managed-profiles", companyId];
  const endpoint = `/companies/${companyId}/remote-agent-profiles`;
  const profiles = useQuery({ queryKey, enabled: Boolean(companyId), queryFn: () => api.get<Profile[]>(`${endpoint}?service=openai_agents_api`) });
  const secrets = useQuery({ queryKey: ["openai-profile-secrets", companyId], enabled: Boolean(companyId && creating), queryFn: () => secretsApi.list(companyId!) });
  const create = useMutation({ mutationFn: () => api.post<Profile>(endpoint, {
    service: "openai_agents_api", profileKey: name.trim(), displayName: name.trim(), credentialSecretId: secret,
    enabled: false, retentionAcknowledged: retention, qualification: {},
    configuration: { defaultModel: "gpt-6-astra", apiRevision: "agents=v1", reasoningEffort: "medium",
      environment: hosted ? { type: "openai_hosted", container_size: "medium", network: { access: "disabled" } } : { type: "none" },
      maxEstimatedSessionCostUsd: 2, timeoutSeconds: 180 },
  }), onSuccess: async () => { await cache.invalidateQueries({ queryKey }); setCreating(false); } });
  return <>
    <Field label="OpenAI managed profile" hint="The profile binds this agent to a company credential and a managed environment.">
      <select className="w-full rounded-md border border-border bg-background text-sm p-2" aria-label="OpenAI managed profile" value={value} onChange={(event) => {
        const profile = profiles.data?.find((entry) => entry.profileKey === event.target.value);
        if (profile) onSelect(profile.profileKey, profile.credentialSecretId, profile.configuration.environment.type === "openai_hosted");
      }}>
        <option value="">Select a profile</option>
        {value && !profiles.data?.some((entry) => entry.profileKey === value) && <option value={value}>{value}</option>}
        {profiles.data?.map((profile) => <option key={profile.id} value={profile.profileKey} disabled={!profile.enabled}>
          {profile.displayName} · {profile.configuration.environment.type === "none" ? "Tools only" : "Hosted workspace"}{!profile.enabled ? " · Qualification required" : ""}
        </option>)}
      </select>
      {profiles.error && <p role="alert" className="text-sm text-destructive">{profiles.error.message}</p>}
      <Button type="button" variant="outline" onClick={() => setCreating(true)}>Create profile</Button>
    </Field>
    {creating && <div className="space-y-3 rounded-md border border-border p-3">
      <Field label="Profile name"><Input aria-label="OpenAI profile name" value={name} onChange={(event) => setName(event.target.value)} placeholder="openai-primary" /></Field>
      <Field label="Company API credential" hint="Create an OpenAI API key in company Secrets first. Credential values stay encrypted on the server.">
        <select aria-label="OpenAI profile credential" className="w-full rounded-md border border-border bg-background text-sm p-2" value={secret} onChange={(event) => setSecret(event.target.value)}>
          <option value="">Select a company secret</option>
          {secrets.data?.filter((entry) => entry.scope === "company" && entry.status === "active").map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        {secrets.error && <p role="alert" className="text-sm text-destructive">{secrets.error.message}</p>}
      </Field>
      <ToggleField label="Hosted workspace" hint="Run code in an OpenAI container with outbound network disabled. Coding tasks require an isolated task worktree." checked={hosted} onChange={setHosted} />
      <ToggleField label="Acknowledge OpenAI retention" hint="OpenAI retains session history and published files." checked={retention} onChange={setRetention} />
      <p className="text-sm text-muted-foreground">New profiles remain disabled until the tools-only or hosted qualification suite passes.</p>
      {create.error && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        <Button type="button" disabled={!companyId || !name.trim() || !secret || !retention || create.isPending} onClick={() => create.mutate()}>Save profile</Button>
      </div>
    </div>}
  </>;
}
