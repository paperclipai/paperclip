# LM Studio Adapter — Dynamische Modell-Dropdowns pro URL

**Datum:** 2026-04-23
**Status:** Spec (pre-implementation)
**Scope:** `paperclip-adapter-lmstudio` + Paperclip-Server + Paperclip-UI

## Problem

Im UI zur Agent-Konfiguration für den LM-Studio-Adapter gibt es vier Felder, die miteinander zusammenhängen:

1. **LM Studio URL** (frei eingebbar)
2. **Modell** (Dropdown)
3. **Fallback LM Studio URL** (frei eingebbar, optional)
4. **Fallback-Modell** (derzeit freie Texteingabe)

Aktuelles Verhalten ist inkonsistent:

- **Modell-Dropdown** listet ausschließlich die Modelle der **lokalen** LM-Studio-Instanz (hardcoded `http://localhost:1234`), selbst wenn im URL-Feld eine externe Maschine eingetragen ist. Ursache: `getConfigSchema()` und `listModels()` im Adapter rufen beide hardcoded die Localhost-URL ab ([paperclip-adapter-lmstudio/src/server/index.ts:38-44](../../../../opensource/paperclip-adapter-lmstudio/src/server/index.ts)).
- **Fallback-Modell** ist im Schema als `type: "text"` deklariert und bietet deshalb keine Auswahl, sondern nur Freitext.

Gewünschtes Verhalten: Beide Modell-Felder sind Comboboxen (Dropdown + freie Eingabe) und laden ihre Optionen vom `/v1/models`-Endpoint ihrer jeweils zugehörigen URL — Modell-Feld von der Primary-URL, Fallback-Modell-Feld von der Fallback-URL.

## Ziele / Non-Ziele

**Ziele:**
- Modell-Dropdown lädt Optionen lazy von der im selben Formular eingetragenen Primary-URL.
- Fallback-Modell-Dropdown lädt Optionen lazy von der im selben Formular eingetragenen Fallback-URL.
- Freie Eingabe bleibt in beiden Feldern möglich (Modellname tippen, auch wenn Server aktuell offline).
- Fallback-Modell-Feld ist deaktiviert, solange keine Fallback-URL gesetzt ist.
- Schema-Mechanismus ist generisch — andere Adapter (z.B. Ollama, beliebige OpenAI-kompatible) können dasselbe Verhalten nutzen.

**Non-Ziele:**
- Kein Auto-Reload der Dropdowns beim Tippen in URL-Felder. Lazy Load erst beim Dropdown-Open.
- Keine UI für das Validieren der URL-Erreichbarkeit. Wenn URL tot → Dropdown leer, manuelle Eingabe bleibt.
- Kein Port/Host-Parsing. Die URL wird 1:1 an den Adapter durchgereicht.
- Keine Migration gespeicherter Agent-Configs nötig — String-Werte sind combobox-kompatibel.

## Design-Entscheidungen (aus Brainstorming)

- **Combobox statt reines Select** — freie Eingabe muss möglich bleiben, auch wenn LM-Studio aktuell nicht erreichbar ist.
- **Lazy Load beim Öffnen des Dropdowns** — keine Requests beim Tippen; erst beim tatsächlichen Öffnen wird `/v1/models` abgefragt. Spart Requests und deckt den Fall "URL noch halb eingetippt" sauber ab.
- **Fallback-Modell-Feld komplett deaktiviert, wenn Fallback-URL leer** — weder Dropdown noch Freitext. Logik: ohne Fallback-URL ist ein Fallback-Modell sinnlos.
- **Generische Schema-Erweiterung** (statt eines LM-Studio-spezifischen React-Components) — kleinerer Eingriff in gemeinsame Infrastruktur, künftig wiederverwendbar.

## Architektur & Datenfluss

Beteiligte Komponenten:

1. **Adapter** ([paperclip-adapter-lmstudio](../../../../opensource/paperclip-adapter-lmstudio/)) — stellt `listModels({ url })` bereit, markiert im Config-Schema URL-abhängige Felder.
2. **Paperclip-Server** ([server/src/routes/agents.ts](../../../server/src/routes/agents.ts), [server/src/adapters/registry.ts](../../../server/src/adapters/registry.ts)) — erweitert Models-Endpoint um `?url=`-Query-Parameter.
3. **Adapter-Utils Types** ([packages/adapter-utils/src/types.ts](../../../packages/adapter-utils/src/types.ts)) — erweitert `ConfigFieldSchema` um `meta.optionsFromUrlField` und `meta.disabledWhenEmpty`.
4. **UI-Schema-Renderer** ([ui/src/adapters/schema-config-fields.tsx](../../../ui/src/adapters/schema-config-fields.tsx)) — lädt beim Öffnen des Combobox-Dropdowns Modelle via React-Query, keyed auf `(adapterType, url)`.

Datenfluss beim Öffnen des Modell-Dropdowns:

```
User klickt Dropdown "Modell"
  ↓
UI liest aktuellen Wert von Feld "url" aus Formular-State
  ↓
React-Query: GET /api/adapters/lmstudio_local/models?url=<encoded>
  ↓ (queryKey: [adapter-models, companyId, type, url] → getrennter Cache pro URL)
Server → registry.listAdapterModels(type, { url })
  ↓
Adapter → fetchModels(url) → /v1/models an LM Studio
  ↓
Liste { id, label }[]
  ↓
Dropdown zeigt Optionen; freie Texteingabe bleibt weiterhin möglich
```

Bei Fehler (URL nicht erreichbar, Timeout, 5xx) liefert der Endpoint `[]`, nicht 500. Die UI zeigt leeren Dropdown mit Hinweis, freie Eingabe funktioniert weiter.

## Schema-Erweiterung

Neuer Feld-Typ `combobox` und zwei neue `meta`-Felder in `ConfigFieldSchema` ([packages/adapter-utils/src/types.ts](../../../packages/adapter-utils/src/types.ts)):

```ts
export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean" | "toggle"
      | "select" | "combobox";
  required?: boolean;
  default?: unknown;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  meta?: {
    providerModels?: Record<string, string[]>;  // bestehend

    // NEU:
    optionsFromUrlField?: string;
    //   Name eines anderen Feldes im selben Schema, das die URL enthält.
    //   UI lädt Optionen lazy beim Öffnen des Dropdowns via
    //   GET /api/adapters/:type/models?url=<value-of-that-field>

    disabledWhenEmpty?: string;
    //   Name eines anderen Feldes. Wenn dessen Wert leer ist,
    //   wird dieses Feld disabled (Dropdown + Eingabe gesperrt).
  };
}
```

LM-Studio-Schema ([paperclip-adapter-lmstudio/src/server/index.ts](../../../../opensource/paperclip-adapter-lmstudio/src/server/index.ts)) nach der Änderung:

```ts
async listModels(opts?: { url?: string }) {
  const models = await fetchModels(opts?.url ?? "http://localhost:1234");
  return models.map((id) => ({ id, label: id }));
},

async getConfigSchema() {
  return {
    version: 1,
    fields: [
      { key: "url", label: "LM Studio URL", type: "text", required: true,
        default: "http://localhost:1234", hint: "URL des LM Studio Servers" },
      { key: "defaultModel", label: "Modell", type: "combobox", required: true,
        hint: "LLM-Modell aus LM Studio",
        meta: { optionsFromUrlField: "url" } },
      { key: "fallbackUrl", label: "Fallback LM Studio URL (optional)",
        type: "text", hint: "..." },
      { key: "fallbackModel", label: "Fallback-Modell (optional)",
        type: "combobox", hint: "...",
        meta: { optionsFromUrlField: "fallbackUrl",
                disabledWhenEmpty: "fallbackUrl" } },
      // restliche Felder unverändert
    ],
  };
}
```

`getConfigSchema()` ruft **kein** `fetchModels()` mehr auf — das Schema wird rein statisch. Modelle werden ausschließlich on-demand geladen, wenn der User ein Dropdown öffnet.

Rückwärtskompatibilität: Bestehende Agent-Configs haben `defaultModel` als String, die Combobox zeigt den Wert korrekt an. Keine Migration nötig.

## Server-Endpoint & Adapter-Interface

Adapter-Interface ([paperclip-adapter-lmstudio/src/server/index.ts](../../../../opensource/paperclip-adapter-lmstudio/src/server/index.ts)) + gemeinsamer `ServerAdapterModule`-Typ in [packages/adapter-utils/src/types.ts](../../../packages/adapter-utils/src/types.ts):

```ts
listModels?: (opts?: { url?: string }) => Promise<Array<{ id: string; label: string }>>;
```

Options sind optional → andere Adapter (claude-local, codex-local, …) brauchen keine Änderung.

Registry ([server/src/adapters/registry.ts](../../../server/src/adapters/registry.ts)):

```ts
export async function listAdapterModels(
  type: string,
  opts?: { url?: string },
): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    try {
      const discovered = await adapter.listModels(opts);
      if (discovered.length > 0) return discovered;
    } catch {
      return [];  // URL unreachable → empty list, not 500
    }
  }
  return adapter.models ?? [];
}
```

Route ([server/src/routes/agents.ts](../../../server/src/routes/agents.ts)):

```ts
router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  const type = assertKnownAdapterType(req.params.type as string);
  const rawUrl = typeof req.query.url === "string" ? req.query.url : undefined;
  const url = rawUrl?.trim() || undefined;
  const models = await listAdapterModels(type, { url });
  res.json(models);
});
```

UI-API-Client ([ui/src/api/agents.ts](../../../ui/src/api/agents.ts)):

```ts
adapterModels: (companyId: string, type: string, url?: string) => {
  const qs = url ? `?url=${encodeURIComponent(url)}` : "";
  return api.get<AdapterModel[]>(
    `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models${qs}`,
  );
},
```

Fetch-Timeout im Adapter-Models-Loader ([paperclip-adapter-lmstudio/src/server/models.ts](../../../../opensource/paperclip-adapter-lmstudio/src/server/models.ts)): falls noch nicht vorhanden, `AbortController` mit ~3 s, damit eine tote URL das UI nicht minutenlang blockiert.

**Security-Hinweis (SSRF):** Der `url`-Query-Parameter erlaubt es authentifizierten Usern, den Paperclip-Server beliebige `http://…/v1/models`-Requests absetzen zu lassen. Da der Endpoint per `assertCompanyAccess` geschützt ist und nur authentifizierte Admins Adapter konfigurieren, ist das Risiko akzeptabel. `fetchModels()` hängt sowieso nur `/v1/models` an — somit kein beliebiger Pfad ansprechbar. Bei späterem Öffnen für weniger privilegierte User ist ein Scheme/Port-Whitelist sinnvoll.

## UI: Combobox mit Lazy-Load & Disabled-State

Zwei Änderungen in [ui/src/adapters/schema-config-fields.tsx](../../../ui/src/adapters/schema-config-fields.tsx):

### ComboboxField erweitert um onOpenChange + disabled + loading

```ts
function ComboboxField({
  value, options, onChange,
  onOpenChange,   // NEU: wird beim Öffnen aufgerufen
  disabled,       // NEU: sperrt Input + Popover-Trigger
  loading,        // NEU: "Lade Modelle…" statt Options
  placeholder,
}: { ... }) { ... }
```

- `disabled=true` → `<input disabled>`, Chevron-Button disabled, `opacity-50`, kein Popover-Öffnen, kein `onChange`.
- `onOpenChange(true)` feuert beim Fokus/Klick → Parent entscheidet über Datenladen.
- `loading=true` → Popover zeigt "Lade Modelle…" statt Optionen.
- Wenn Fetch `[]` liefert, zeigt der Popover die bestehende "Use X as custom value"-Hinweiszeile → freie Eingabe funktioniert.

### Neuer Case combobox mit URL-abhängigen Optionen

Ergänzt den bestehenden Switch-Block:

```tsx
case "combobox": {
  const currentVal = String(readValue(field) ?? "");

  // Fall A: URL-abhängige Optionen (NEU)
  if (field.meta?.optionsFromUrlField) {
    const urlFieldKey = field.meta.optionsFromUrlField;
    const urlFieldSchema = schema.fields.find((f) => f.key === urlFieldKey);
    const urlValue = String(
      urlFieldSchema ? readValue(urlFieldSchema) ?? "" : ""
    ).trim();

    const disabledField = field.meta.disabledWhenEmpty;
    const isDisabled = disabledField
      ? !String(readValue(schema.fields.find((f) => f.key === disabledField)!) ?? "").trim()
      : false;

    return (
      <Field key={field.key} label={field.label} hint={field.hint}>
        <UrlModelsCombobox
          adapterType={adapterType}
          companyId={selectedCompanyId}
          url={urlValue}
          value={currentVal}
          disabled={isDisabled}
          onChange={(v) => writeValue(field, v || undefined)}
          placeholder={field.hint}
        />
      </Field>
    );
  }

  // Fall B: providerModels (bestehend, unverändert)
}
```

### Hilfskomponente UrlModelsCombobox

Kapselt React-Query-Lazy-Load:

```tsx
function UrlModelsCombobox({
  adapterType, companyId, url, value, disabled, onChange, placeholder,
}: { ... }) {
  const [hasOpened, setHasOpened] = useState(false);

  const { data: models, isFetching } = useQuery({
    queryKey: ["adapter-models", companyId, adapterType, url],
    queryFn: () => agentsApi.adapterModels(companyId!, adapterType, url),
    enabled: hasOpened && !disabled && Boolean(companyId) && url.length > 0,
    staleTime: 30_000,
  });

  const options = (models ?? []).map((m) => ({ label: m.label, value: m.id }));

  return (
    <ComboboxField
      value={value}
      options={options}
      disabled={disabled}
      loading={isFetching}
      onOpenChange={(open) => { if (open) setHasOpened(true); }}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}
```

Eigenschaften:

- **Lazy:** `enabled: hasOpened` → Request erst nach dem ersten Öffnen.
- **Per URL gecacht:** `queryKey` enthält `url`. URL ändern und erneut öffnen → frischer Fetch, separater Cache-Eintrag.
- **Staleness 30 s:** Schnelles zweites Öffnen nutzt Cache; nach 30 s neu. Deckt den Fall ab, dass zwischendurch ein neues Modell in LM Studio geladen wird.
- **Disabled:** Bei leerer Fallback-URL bleibt das Feld ausgegraut.
- **Freie Eingabe:** Über bestehendes `ComboboxField`-Verhalten (Enter committed den getippten Wert).

### AgentConfigForm bleibt weitgehend unverändert

Der bestehende `useQuery` auf `adapterModels` in [ui/src/components/AgentConfigForm.tsx](../../../ui/src/components/AgentConfigForm.tsx) bleibt als Fallback für Adapter ohne `optionsFromUrlField` (claude-local etc.).

## Fehler- & Edge-Cases

- **URL leer (Primary):** `enabled: url.length > 0` → kein Request. Dropdown bleibt leer beim Öffnen, freie Eingabe möglich.
- **URL ungültig / Tippfehler / Host down:** Adapter wirft im `fetchModels()` (Timeout/Connection-Error). Registry fängt → `[]`. Dropdown öffnet leer, freie Eingabe funktioniert.
- **URL ändert sich während Dropdown offen:** Realistischer Fall selten, weil URL-Input nicht fokussiert ist, während Popover offen. Falls doch: React-Query sieht neuen `queryKey`, fetcht frisch beim nächsten Öffnen.
- **Primary und Fallback zeigen auf gleiche URL:** Beide Dropdowns erhalten identischen `queryKey` → ein geteilter Cache-Eintrag, nur ein Request. OK.
- **Fallback-Modell war gesetzt, Fallback-URL wird gelöscht:** Feld wird disabled. Der gespeicherte Wert bleibt im State, wird aber nicht editierbar. Beim Speichern entscheidet der Adapter-Config-Builder, ob ein Fallback-Modell ohne Fallback-URL überhaupt persistiert wird (out of scope für diese Spec).

## Testing

### Adapter-Package (Vitest)

Unter [paperclip-adapter-lmstudio/tests/](../../../../opensource/paperclip-adapter-lmstudio/tests/):

- `listModels({ url })` ruft `fetchModels(url)` mit der übergebenen URL auf (nicht hardcoded localhost).
- `listModels()` ohne opts fällt auf `http://localhost:1234` zurück.
- `listModels({ url: "http://tote-url:9999" })` wirft Error bei Timeout.
- `getConfigSchema()` ruft kein `fetchModels` mehr auf (keine Netzwerk-Requests beim Schema-Abruf). `defaultModel` hat `type: "combobox"` + `meta.optionsFromUrlField: "url"`; `fallbackModel` analog mit `fallbackUrl` + `disabledWhenEmpty`.

### Server (Vitest)

- `listAdapterModels(type, { url })` reicht `url` durch.
- `listAdapterModels(type, { url: tot })` → `[]`, kein 500.
- `GET /companies/:id/adapters/lmstudio_local/models?url=http://x:1234` → 200 mit Modell-Liste von x.
- `GET` ohne `url` → 200 mit Default-Modellen.
- Leeres `url=` → wie ohne URL behandelt.

### UI-Komponente (Vitest + React Testing Library)

- **Lazy Load:** Beim Render kein Request; erst beim Dropdown-Open fliegt Request mit `url=<Primary>`.
- **URL-Wechsel:** Öffnen → Request A. URL ändern. Erneut öffnen → Request B mit neuer URL. Getrennte Cache-Einträge.
- **Freie Eingabe:** "my-custom-model" tippen → Enter → `writeValue` mit diesem String, auch wenn nicht in Options.
- **Leere Options:** Mock liefert `[]`. Popover zeigt "Use X as custom value". Freie Eingabe ok.
- **Fallback-Disabled:** `fallbackUrl = ""` → Fallback-Modell-Feld disabled, Chevron öffnet nichts. `fallbackUrl` setzen → Feld aktiv.
- **Fallback-URL gesetzt:** Dropdown öffnet → Request mit `url=<fallbackUrl>` (nicht Primary).

### Manueller Smoke-Test (verpflichtend bei UI-Änderungen)

1. Dev-Server starten, Agent mit Adapter `lmstudio_local` öffnen.
2. Primary-URL auf lokale LM-Studio-Instanz → "Modell" zeigt lokale Modelle.
3. Primary-URL auf externe Maschine → Dropdown neu öffnen → dortige Modelle erscheinen.
4. Fallback-URL leer → Fallback-Modell-Feld ausgegraut.
5. Fallback-URL setzen → Fallback-Modell-Dropdown aktiv, Modelle der Fallback-Maschine.
6. URL tippfehlerhaft → Dropdown öffnet leer + "Use X as custom value", manuelle Eingabe funktioniert.

## Offene Punkte / Follow-ups

- Ein optionaler Refresh-Button neben dem Dropdown ("Modelle neu laden") wäre schön, ist aber nicht Teil dieser Spec. Der 30-s-`staleTime` deckt den häufigen Fall ab.
- Der bestehende globale `useQuery` in `AgentConfigForm` ruft `/adapters/:type/models` beim Form-Mount ohne `url` auf. Für LM-Studio ist das Ergebnis redundant (wird von `UrlModelsCombobox` nicht mehr genutzt). Optimierung: den Global-Query überspringen, wenn das Schema ausschließlich `optionsFromUrlField`-Felder enthält. Nicht blockierend; kleiner Waste-Request.
- Falls künftig andere Adapter (Ollama, OpenAI-kompatible) dasselbe Pattern nutzen, bietet sich ein kleines `listModels`-Convention-Doc unter `docs/adapters/` an.
