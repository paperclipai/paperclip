import { useEffect, useMemo, useState } from "react";
import { ControlSidebar } from "./components/ControlSidebar";
import { WorkspaceWebview } from "./components/WorkspaceWebview";
import type { ConnectionProbe, DesktopConfig, DesktopMeta } from "./types";

const DEFAULT_CONFIG: DesktopConfig = {
  baseUrl: "http://127.0.0.1:3100",
  workspacePrefix: "",
  lastLaunchUrl: "",
};

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_CONFIG.baseUrl;
  return trimmed.replace(/\/+$/, "");
}

function buildLaunchUrl(baseUrl: string, workspacePrefix: string) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPrefix = workspacePrefix.trim().toUpperCase();
  return normalizedPrefix ? `${normalizedBase}/${normalizedPrefix}/dashboard` : `${normalizedBase}/dashboard`;
}

export default function App() {
  const [meta, setMeta] = useState<DesktopMeta | null>(null);
  const [config, setConfig] = useState<DesktopConfig>(DEFAULT_CONFIG);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_CONFIG.baseUrl);
  const [workspacePrefix, setWorkspacePrefix] = useState(DEFAULT_CONFIG.workspacePrefix);
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);
  const [isBusy, setIsBusy] = useState(true);
  const [webviewLocation, setWebviewLocation] = useState("");

  const launchUrl = useMemo(
    () => buildLaunchUrl(probe?.baseUrl ?? baseUrl, workspacePrefix),
    [baseUrl, probe?.baseUrl, workspacePrefix],
  );

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      setIsBusy(true);
      const [appMeta, storedConfig] = await Promise.all([
        window.neurOSDesktop.meta(),
        window.neurOSDesktop.loadConfig(),
      ]);

      if (!active) return;

      setMeta(appMeta);
      setConfig(storedConfig);
      setBaseUrl(storedConfig.baseUrl);
      setWorkspacePrefix(storedConfig.workspacePrefix);

      const detected = await window.neurOSDesktop.detectConnection();
      if (!active) return;

      setProbe(detected);

      if (detected.ok) {
        const nextWorkspacePrefix =
          storedConfig.workspacePrefix &&
          detected.companies.some((company) => company.issuePrefix === storedConfig.workspacePrefix)
            ? storedConfig.workspacePrefix
            : detected.companies[0]?.issuePrefix ?? "";

        const nextConfig = await window.neurOSDesktop.saveConfig({
          baseUrl: detected.baseUrl,
          workspacePrefix: nextWorkspacePrefix,
          lastLaunchUrl: buildLaunchUrl(detected.baseUrl, nextWorkspacePrefix),
        });

        if (!active) return;
        setConfig(nextConfig);
        setBaseUrl(nextConfig.baseUrl);
        setWorkspacePrefix(nextConfig.workspacePrefix);
      }

      setIsBusy(false);
    }

    bootstrap();

    return () => {
      active = false;
    };
  }, []);

  async function connectToTarget() {
    setIsBusy(true);
    const result = await window.neurOSDesktop.probeConnection(baseUrl);
    setProbe(result);

    if (result.ok) {
      const nextConfig = await window.neurOSDesktop.saveConfig({
        baseUrl: result.baseUrl,
        workspacePrefix,
        lastLaunchUrl: buildLaunchUrl(result.baseUrl, workspacePrefix),
      });
      setConfig(nextConfig);
      setBaseUrl(nextConfig.baseUrl);
    }

    setIsBusy(false);
  }

  async function handleWorkspaceChange(value: string) {
    setWorkspacePrefix(value);
    const nextConfig = await window.neurOSDesktop.saveConfig({
      workspacePrefix: value,
      lastLaunchUrl: buildLaunchUrl(probe?.baseUrl ?? baseUrl, value),
    });
    setConfig(nextConfig);
  }

  async function handleOpenExternal() {
    await window.neurOSDesktop.openExternal(launchUrl);
  }

  async function handleLocationChange(value: string) {
    setWebviewLocation(value);
    await window.neurOSDesktop.saveConfig({ lastLaunchUrl: value });
  }

  return (
    <div className="app-shell">
      <ControlSidebar
        meta={meta}
        baseUrl={baseUrl}
        workspacePrefix={workspacePrefix}
        probe={probe}
        isBusy={isBusy}
        onBaseUrlChange={setBaseUrl}
        onWorkspacePrefixChange={handleWorkspaceChange}
        onConnect={connectToTarget}
        onOpenExternal={handleOpenExternal}
        launchUrl={launchUrl}
      />

      <main className="workspace-panel">
        <header className="workspace-header">
          <div>
            <div className="eyebrow">Workspace ativo</div>
            <h2>{workspacePrefix ? `${workspacePrefix} dashboard` : "Board dashboard"}</h2>
          </div>
          <div className="workspace-meta">
            <span>{probe?.baseUrl ?? baseUrl}</span>
            <span>{webviewLocation || launchUrl}</span>
          </div>
        </header>

        {probe?.ok ? (
          <WorkspaceWebview src={launchUrl} onLocationChange={handleLocationChange} />
        ) : (
          <section className="workspace-empty">
            <div className="empty-card">
              <div className="eyebrow">API indisponível</div>
              <h2>O app Electron não tenta bootstraps automáticos.</h2>
              <p>
                Ele só conecta em uma instância Paperclip já acessível. Como o seu board web já funciona, use a
                mesma URL base aqui e clique em conectar.
              </p>
              <code>{`curl ${normalizeBaseUrl(baseUrl)}/api/health`}</code>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
