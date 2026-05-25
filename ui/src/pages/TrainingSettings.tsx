import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CalendarDays,
  Check,
  Dumbbell,
  ExternalLink,
  HeartPulse,
  Link2,
  LockKeyhole,
  RotateCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

type ProviderId = "openai" | "anthropic" | "gemini" | "openrouter" | "other";
type IntegrationId = "garmin" | "strava";

type AiProvider = {
  id: ProviderId;
  name: string;
  description: string;
  models: string[];
  accent: string;
};

type AiProviderState = {
  connected: boolean;
  model: string;
  customModel?: string;
};

type IntegrationState = {
  connected: boolean;
  syncCompletedActivities: boolean;
  syncPlannedWorkouts: boolean;
  autoSync: boolean;
  healthMetrics: {
    sleep: boolean;
    hrv: boolean;
    restingHeartRate: boolean;
    trainingReadiness: boolean;
  };
};

type TrainingSettingsState = {
  providers: Record<ProviderId, AiProviderState>;
  integrations: Record<IntegrationId, IntegrationState>;
};

const STORAGE_KEY = "paperclip.trainingSettings.v1";

const AI_PROVIDERS: AiProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "Use GPT models for plan generation, workout analysis, and calendar adjustments.",
    models: ["gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    accent: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Connect Claude for longer coaching context and conservative training recommendations.",
    models: ["claude-3.7-sonnet", "claude-3.5-sonnet", "claude-3.5-haiku"],
    accent: "bg-orange-500/10 text-orange-700 border-orange-500/20",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Use Gemini models for multimodal workout notes and fast calendar summaries.",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro"],
    accent: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Route training workflows through a selected third-party model catalog.",
    models: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet", "google/gemini-2.5-pro"],
    accent: "bg-purple-500/10 text-purple-700 border-purple-500/20",
  },
  {
    id: "other",
    name: "Other",
    description: "Reserve a custom provider slot for bring-your-own gateway experiments.",
    models: ["custom-model"],
    accent: "bg-slate-500/10 text-slate-700 border-slate-500/20",
  },
];

const DEFAULT_INTEGRATION: IntegrationState = {
  connected: false,
  syncCompletedActivities: true,
  syncPlannedWorkouts: true,
  autoSync: false,
  healthMetrics: {
    sleep: true,
    hrv: true,
    restingHeartRate: true,
    trainingReadiness: false,
  },
};

function createDefaultState(): TrainingSettingsState {
  return {
    providers: AI_PROVIDERS.reduce((acc, provider) => {
      acc[provider.id] = {
        connected: false,
        model: provider.models[0] ?? "custom-model",
        customModel: provider.id === "other" ? "" : undefined,
      };
      return acc;
    }, {} as Record<ProviderId, AiProviderState>),
    integrations: {
      garmin: { ...DEFAULT_INTEGRATION },
      strava: {
        ...DEFAULT_INTEGRATION,
        healthMetrics: {
          sleep: false,
          hrv: false,
          restingHeartRate: true,
          trainingReadiness: false,
        },
      },
    },
  };
}

function loadSettings(): TrainingSettingsState {
  const defaults = createDefaultState();
  if (typeof window === "undefined") return defaults;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<TrainingSettingsState>;

    return {
      providers: {
        ...defaults.providers,
        ...(parsed.providers ?? {}),
      },
      integrations: {
        garmin: {
          ...defaults.integrations.garmin,
          ...(parsed.integrations?.garmin ?? {}),
          healthMetrics: {
            ...defaults.integrations.garmin.healthMetrics,
            ...(parsed.integrations?.garmin?.healthMetrics ?? {}),
          },
        },
        strava: {
          ...defaults.integrations.strava,
          ...(parsed.integrations?.strava ?? {}),
          healthMetrics: {
            ...defaults.integrations.strava.healthMetrics,
            ...(parsed.integrations?.strava?.healthMetrics ?? {}),
          },
        },
      },
    };
  } catch {
    return defaults;
  }
}

function StatusBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge className="gap-1 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10">
      <Check className="h-3 w-3" /> Connected
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Unplug className="h-3 w-3" /> Not connected
    </Badge>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-background/60 p-3">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <div className="grid gap-1 leading-none">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function TrainingSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [settings, setSettings] = useState<TrainingSettingsState>(() => loadSettings());

  useEffect(() => {
    document.title = "Training Settings · Paperclip";
    setBreadcrumbs([
      { label: "Training", href: "/training" },
      { label: "Settings" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const connectedProviderCount = useMemo(
    () => Object.values(settings.providers).filter((provider) => provider.connected).length,
    [settings.providers],
  );

  const connectedIntegrationCount = useMemo(
    () => Object.values(settings.integrations).filter((integration) => integration.connected).length,
    [settings.integrations],
  );

  function updateProvider(providerId: ProviderId, patch: Partial<AiProviderState>) {
    setSettings((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [providerId]: {
          ...current.providers[providerId],
          ...patch,
        },
      },
    }));
  }

  function updateIntegration(integrationId: IntegrationId, patch: Partial<IntegrationState>) {
    setSettings((current) => ({
      ...current,
      integrations: {
        ...current.integrations,
        [integrationId]: {
          ...current.integrations[integrationId],
          ...patch,
        },
      },
    }));
  }

  function updateHealthMetric(
    integrationId: IntegrationId,
    key: keyof IntegrationState["healthMetrics"],
    value: boolean,
  ) {
    setSettings((current) => ({
      ...current,
      integrations: {
        ...current.integrations,
        [integrationId]: {
          ...current.integrations[integrationId],
          healthMetrics: {
            ...current.integrations[integrationId].healthMetrics,
            [key]: value,
          },
        },
      },
    }));
  }

  function resetSettings() {
    const defaults = createDefaultState();
    setSettings(defaults);
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Training Settings</h1>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Configure the standalone training calendar surface. These controls are UI-only placeholders for provider OAuth, model selection, activity sync, and health metric preferences.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={resetSettings} className="gap-2">
          <RotateCw className="h-4 w-4" /> Reset local settings
        </Button>
      </div>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-start">
          <ShieldCheck className="h-5 w-5 shrink-0 text-amber-700" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Security note for this UI iteration</p>
            <p className="text-sm text-muted-foreground">
              OAuth grants are placeholders in this screen. Connect buttons only update local UI state, model choices and sync preferences are saved in localStorage, and no tokens, API keys, or secrets are requested or shown.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Bot className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">{connectedProviderCount}</p>
              <p className="text-xs text-muted-foreground">AI providers connected</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">{connectedIntegrationCount}</p>
              <p className="text-xs text-muted-foreground">Fitness integrations connected</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <LockKeyhole className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">0</p>
              <p className="text-xs text-muted-foreground">Secrets stored by this page</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">AI providers</h2>
            <p className="text-sm text-muted-foreground">Connect a model source for workout analysis and plan generation.</p>
          </div>
          <Badge variant="outline" className="gap-1">
            <Sparkles className="h-3 w-3" /> Calendar coach
          </Badge>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {AI_PROVIDERS.map((provider) => {
            const providerState = settings.providers[provider.id];
            return (
              <Card key={provider.id}>
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={provider.accent}>{provider.name}</Badge>
                        <StatusBadge connected={providerState.connected} />
                      </div>
                      <CardTitle className="text-base">{provider.name}</CardTitle>
                      <CardDescription>{provider.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={providerState.connected ? "outline" : "default"}
                      className="gap-2"
                      onClick={() => updateProvider(provider.id, { connected: !providerState.connected })}
                    >
                      {providerState.connected ? <Unplug className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
                      {providerState.connected ? "Disconnect" : `Connect ${provider.name}`}
                    </Button>
                    {!providerState.connected && (
                      <Button type="button" size="sm" variant="ghost" className="gap-2" disabled>
                        <Link2 className="h-4 w-4" /> OAuth placeholder
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`${provider.id}-model`}>Model</Label>
                    <Select
                      value={providerState.model}
                      onValueChange={(model) => updateProvider(provider.id, { model })}
                      disabled={!providerState.connected}
                    >
                      <SelectTrigger id={`${provider.id}-model`} className="w-full">
                        <SelectValue placeholder="Connect provider to choose a model" />
                      </SelectTrigger>
                      <SelectContent>
                        {provider.models.map((model) => (
                          <SelectItem key={model} value={model}>{model}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {provider.id === "other" && (
                      <Input
                        value={providerState.customModel ?? ""}
                        disabled={!providerState.connected}
                        placeholder="Custom provider/model name"
                        onChange={(event) => updateProvider(provider.id, { customModel: event.target.value })}
                      />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {providerState.connected
                        ? "Model preference is available and persisted locally."
                        : "Model selection unlocks after the placeholder connection is enabled."}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Fitness integrations</h2>
          <p className="text-sm text-muted-foreground">Choose training data sources and the metrics the calendar may use for recommendations.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <IntegrationCard
            id="garmin"
            name="Garmin"
            description="Import completed workouts, planned workouts, and device-driven recovery signals from Garmin when official access is available."
            state={settings.integrations.garmin}
            onPatch={(patch) => updateIntegration("garmin", patch)}
            onHealthMetric={(key, value) => updateHealthMetric("garmin", key, value)}
          />
          <IntegrationCard
            id="strava"
            name="Strava"
            description="Use Strava as a social activity source and fallback sync path for completed endurance workouts."
            state={settings.integrations.strava}
            onPatch={(patch) => updateIntegration("strava", patch)}
            onHealthMetric={(key, value) => updateHealthMetric("strava", key, value)}
          />
        </div>
      </section>
    </div>
  );
}

function IntegrationCard({
  id,
  name,
  description,
  state,
  onPatch,
  onHealthMetric,
}: {
  id: IntegrationId;
  name: string;
  description: string;
  state: IntegrationState;
  onPatch: (patch: Partial<IntegrationState>) => void;
  onHealthMetric: (key: keyof IntegrationState["healthMetrics"], value: boolean) => void;
}) {
  const disabled = !state.connected;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1">
                {id === "garmin" ? <Dumbbell className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
                {name}
              </Badge>
              <StatusBadge connected={state.connected} />
            </div>
            <CardTitle className="text-base">{name}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          type="button"
          size="sm"
          variant={state.connected ? "outline" : "default"}
          className="gap-2"
          onClick={() => onPatch({ connected: !state.connected })}
        >
          {state.connected ? <Unplug className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
          {state.connected ? "Disconnect" : `Connect ${name}`}
        </Button>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Settings className="h-4 w-4 text-muted-foreground" /> Sync preferences
          </div>
          <div className="grid gap-2">
            <ToggleRow
              id={`${id}-completed`}
              label="Completed activities"
              description="Import runs, rides, swims, and strength sessions into the training calendar."
              checked={state.syncCompletedActivities}
              disabled={disabled}
              onChange={(syncCompletedActivities) => onPatch({ syncCompletedActivities })}
            />
            <ToggleRow
              id={`${id}-planned`}
              label="Planned workouts"
              description="Allow planned calendar workouts to be prepared for export when an API supports it."
              checked={state.syncPlannedWorkouts}
              disabled={disabled}
              onChange={(syncPlannedWorkouts) => onPatch({ syncPlannedWorkouts })}
            />
            <ToggleRow
              id={`${id}-autosync`}
              label="Automatic background sync"
              description="Keep calendar data fresh without manual imports. Placeholder only in this iteration."
              checked={state.autoSync}
              disabled={disabled}
              onChange={(autoSync) => onPatch({ autoSync })}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <HeartPulse className="h-4 w-4 text-muted-foreground" /> Health metrics
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleRow
              id={`${id}-sleep`}
              label="Sleep"
              description="Use sleep trends for recovery-aware planning."
              checked={state.healthMetrics.sleep}
              disabled={disabled}
              onChange={(value) => onHealthMetric("sleep", value)}
            />
            <ToggleRow
              id={`${id}-hrv`}
              label="HRV"
              description="Factor heart-rate variability into readiness guidance."
              checked={state.healthMetrics.hrv}
              disabled={disabled}
              onChange={(value) => onHealthMetric("hrv", value)}
            />
            <ToggleRow
              id={`${id}-rhr`}
              label="Resting HR"
              description="Watch baseline resting heart rate changes."
              checked={state.healthMetrics.restingHeartRate}
              disabled={disabled}
              onChange={(value) => onHealthMetric("restingHeartRate", value)}
            />
            <ToggleRow
              id={`${id}-readiness`}
              label="Readiness"
              description="Include vendor readiness scores when available."
              checked={state.healthMetrics.trainingReadiness}
              disabled={disabled}
              onChange={(value) => onHealthMetric("trainingReadiness", value)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default TrainingSettings;
