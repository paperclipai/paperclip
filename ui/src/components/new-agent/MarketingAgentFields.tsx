import { useId, useState } from "react";
import {
  MARKETING_AGENT_TEMPLATES, createMarketingAgentProfile,
  type MarketingAgentProfile, type MarketingAgentTypeId,
} from "@paperclipai/shared";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { SelectPopover, SelectPopoverItem } from "../ui/select";

const fields = [
  ["responsibilities", "Responsabilidades"],
  ["instructions", "Instruções"],
  ["expectedInputs", "Entradas esperadas"],
  ["deliverables", "Entregáveis"],
  ["qualityCriteria", "Critérios de qualidade"],
] as const;

export function MarketingAgentFields({ value, onChange, disabled = false }: {
  value: MarketingAgentProfile | null;
  onChange: (profile: MarketingAgentProfile) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [pendingType, setPendingType] = useState<MarketingAgentTypeId | null>(null);
  const selected = MARKETING_AGENT_TEMPLATES.find(item => item.id === value?.typeId);
  const normalized = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const choices = MARKETING_AGENT_TEMPLATES.filter(item => normalized(item.label).includes(normalized(search)));
  function select(typeId: MarketingAgentTypeId) {
    setOpen(false);
    setSearch("");
    if (typeId === value?.typeId) return;
    if (value) setPendingType(typeId);
    else onChange(createMarketingAgentProfile(typeId));
  }
  return <div className="space-y-4">
    <div className="space-y-2">
      <label className="text-sm font-medium">Tipo de agente *</label>
      <SelectPopover aria-label="Tipo de agente" value={value?.typeId ?? ""}
        displayValue={selected?.label} placeholder="Selecione um dos 12 tipos"
        disabled={disabled} open={open} onOpenChange={setOpen}>
        <div className="space-y-2">
          <Input aria-label="Buscar tipo de agente" placeholder="Buscar cargo…" value={search}
            onChange={event => setSearch(event.target.value)} />
          <div role="listbox" aria-label="Tipos de agentes" className="max-h-64 overflow-y-auto">
            {choices.map(item => <SelectPopoverItem key={item.id} selected={item.id === value?.typeId}
              onClick={() => select(item.id)}>{item.label}</SelectPopoverItem>)}
            {!choices.length && <p className="p-2 text-sm text-muted-foreground">Nenhum tipo encontrado.</p>}
          </div>
        </div>
      </SelectPopover>
    </div>
    {pendingType && <div role="status" className="space-y-2 rounded-md border p-3">
      <p className="text-sm">Alterar para {MARKETING_AGENT_TEMPLATES.find(item => item.id === pendingType)?.label}?
        As instruções atuais serão preservadas, a menos que você escolha aplicar o novo modelo.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={disabled} onClick={() => {
          const next = createMarketingAgentProfile(pendingType);
          onChange({ ...next, ...value!, typeId: pendingType, templateVersion: next.templateVersion });
          setPendingType(null);
        }}>Manter personalizações</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => {
          onChange({ ...createMarketingAgentProfile(pendingType), specialization: value?.specialization ?? "" });
          setPendingType(null);
        }}>Aplicar novo modelo</Button>
        <Button type="button" variant="ghost" onClick={() => setPendingType(null)}>Cancelar alteração</Button>
      </div>
    </div>}
    {value && <>
      <div className="space-y-2">
        <label htmlFor={`${id}-specialization`} className="text-sm font-medium">Especialização (opcional)</label>
        <Input id={`${id}-specialization`} value={value.specialization} maxLength={500} disabled={disabled}
          placeholder="Ex.: Meta Ads, SEO, identidade visual"
          onChange={event => onChange({ ...value, specialization: event.target.value })} />
      </div>
      <details className="space-y-3" open>
        <summary className="cursor-pointer text-sm font-medium">Revisar responsabilidades e instruções</summary>
        {fields.map(([key, label]) => <div key={key} className="space-y-2">
          <label htmlFor={`${id}-${key}`} className="text-sm font-medium">{label}</label>
          <Textarea id={`${id}-${key}`} value={value[key]} required maxLength={12000} disabled={disabled}
            rows={3} onChange={event => onChange({ ...value, [key]: event.target.value })} />
        </div>)}
      </details>
      <p className="text-sm text-muted-foreground">Modelo, conta e ferramentas serão configurados separadamente.
        O cargo não concede permissões nem inicia tarefas.</p>
    </>}
  </div>;
}
