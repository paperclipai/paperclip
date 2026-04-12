import type { ChangeEvent } from "react";
import type { CompanyInfo, ConnectionProbe, DesktopMeta } from "../types";
import { StatusBadge } from "./StatusBadge";

interface ControlSidebarProps {
  meta: DesktopMeta | null;
  baseUrl: string;
  workspacePrefix: string;
  probe: ConnectionProbe | null;
  isBusy: boolean;
  onBaseUrlChange: (value: string) => void;
  onWorkspacePrefixChange: (value: string) => void;
  onConnect: () => void;
  onOpenExternal: () => void;
  launchUrl: string;
}

function toneForProbe(probe: ConnectionProbe | null): "neutral" | "success" | "warning" | "danger" {
  if (!probe) return "neutral";
  return probe.ok ? "success" : "danger";
}

function labelForProbe(probe: ConnectionProbe | null): string {
  if (!probe) return "Aguardando";
  return probe.ok ? "Conectado" : "Sem conexão";
}

export function ControlSidebar({
  meta,
  baseUrl,
  workspacePrefix,
  probe,
  isBusy,
  onBaseUrlChange,
  onWorkspacePrefixChange,
  onConnect,
  onOpenExternal,
  launchUrl,
}: ControlSidebarProps) {
  const workspaceOptions: CompanyInfo[] = probe?.companies ?? [];

  return (
    <aside className="control-sidebar">
      <div className="panel hero-panel">
        <div className="eyebrow">GoldNeuron Desktop Shell</div>
        <h1>neurOS Electron</h1>
        <p>
          Wrapper estável para o board web do Paperclip, com seleção de workspace e conexão direta à API
          local já existente.
        </p>
        <div className="badge-row">
          <StatusBadge tone={toneForProbe(probe)} label={labelForProbe(probe)} />
          <StatusBadge tone="neutral" label={meta ? `v${meta.version}` : "carregando"} />
        </div>
      </div>

      <div className="panel form-panel">
        <label className="field">
          <span>Base URL</span>
          <input
            type="text"
            value={baseUrl}
            placeholder="http://127.0.0.1:3100"
            onChange={(event: ChangeEvent<HTMLInputElement>) => onBaseUrlChange(event.target.value)}
          />
        </label>

        <label className="field">
          <span>Workspace prefix</span>
          <input
            type="text"
            value={workspacePrefix}
            placeholder="BC ou GOL"
            onChange={(event: ChangeEvent<HTMLInputElement>) => onWorkspacePrefixChange(event.target.value.toUpperCase())}
          />
        </label>

        {workspaceOptions.length > 0 ? (
          <label className="field">
            <span>Workspaces detectados</span>
            <select value={workspacePrefix} onChange={(event) => onWorkspacePrefixChange(event.target.value)}>
              <option value="">Board geral</option>
              {workspaceOptions.map((company) => (
                <option key={company.id} value={company.issuePrefix}>
                  {company.issuePrefix ? `${company.issuePrefix} · ${company.name}` : company.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="action-row">
          <button className="primary-button" onClick={onConnect} disabled={isBusy}>
            {isBusy ? "Verificando..." : "Conectar"}
          </button>
          <button className="secondary-button" onClick={onOpenExternal} disabled={!launchUrl}>
            Abrir no navegador
          </button>
        </div>
      </div>

      <div className="panel details-panel">
        <div className="detail-line">
          <span>Status</span>
          <strong>{probe?.ok ? "API acessível" : "Aguardando API"}</strong>
        </div>
        <div className="detail-line">
          <span>URL ativa</span>
          <strong>{probe?.baseUrl ?? baseUrl}</strong>
        </div>
        <div className="detail-line">
          <span>Destino</span>
          <strong>{launchUrl || "Sem rota ativa"}</strong>
        </div>
        <div className="detail-line">
          <span>Modo</span>
          <strong>{probe?.health?.deploymentMode ?? "desconhecido"}</strong>
        </div>
        <div className="detail-line">
          <span>Bootstrap</span>
          <strong>{probe?.health?.bootstrapStatus ?? "n/a"}</strong>
        </div>
        {probe?.error ? <p className="error-copy">{probe.error}</p> : null}
      </div>
    </aside>
  );
}
