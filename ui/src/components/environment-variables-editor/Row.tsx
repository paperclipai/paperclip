import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  KeyRound,
  MoreHorizontal,
  ShieldAlert,
  Type as TypeIcon,
  UserRound,
  X,
} from "lucide-react";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SecretPicker } from "./SecretPicker";
import { CreateSecretPopover, ConvertToSecretPopover } from "./CreateSecretPopover";
import { isSensitiveEnv } from "./sensitive";
import {
  computeRowHealth,
  computeUserSecretRowHealth,
  planSourceSwitch,
  secretNameFromKey,
  type EnvRow,
  type NameIssue,
  type RowSource,
} from "./model";

const nameInputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40";

const valueTextInputClass =
  "min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm font-mono outline-none placeholder:text-muted-foreground/40";

type SecretPopoverState = { mode: "create" | "store"; name: string; value: string } | null;
export interface EnvironmentVariableDirtyFields {
  name: boolean;
  value: boolean;
}

export interface EnvironmentVariableRowProps {
  row: EnvRow;
  isLast: boolean;
  secrets: readonly CompanySecret[];
  userSecretDefinitions?: readonly UserSecretDefinition[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  disabled?: boolean;
  nameIssue: NameIssue | null;
  showNameIssue: boolean;
  dirtyFields: EnvironmentVariableDirtyFields;
  onPatch: (patch: Partial<EnvRow>) => void;
  onRemove: () => void;
  onNameBlur: () => void;
  /** Handle a multi-line dotenv paste into the (empty) name field. Returns true if consumed. */
  onNamePaste: (text: string) => boolean;
  /** Enter pressed in the value of the last row — append a fresh row and focus it. */
  onEnterInValueLast: () => void;
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onToast: (message: string) => void;
  /** Parent-driven focus request for this row (append flow, source switch). */
  focusRequest: "name" | "value" | null;
  onFocusConsumed: () => void;
}

export function EnvironmentVariableRow({
  row,
  isLast,
  secrets,
  userSecretDefinitions,
  recentlyUsedSecrets,
  disabled,
  nameIssue,
  showNameIssue,
  dirtyFields,
  onPatch,
  onRemove,
  onNameBlur,
  onNamePaste,
  onEnterInValueLast,
  onCreateSecret,
  onToast,
  focusRequest,
  onFocusConsumed,
}: EnvironmentVariableRowProps) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const valueInputRef = useRef<HTMLInputElement | null>(null);
  const valueCellRef = useRef<HTMLDivElement | null>(null);
  const [secretPopover, setSecretPopover] = useState<SecretPopoverState>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const [undoPrev, setUndoPrev] = useState<EnvRow | null>(null);

  const health = computeRowHealth(row, secrets) ?? computeUserSecretRowHealth(row, userSecretDefinitions);
  const boundSecret = row.source === "secret" ? secrets.find((s) => s.id === row.secretId) ?? null : null;
  const userSecretsEnabled = (userSecretDefinitions?.length ?? 0) > 0;
  const sensitive =
    row.source === "text" && !row.sensitiveDismissed && isSensitiveEnv(row.name, row.textValue);

  // Consume parent focus requests (append / source-switch flows).
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest === "name") {
      nameInputRef.current?.focus();
    } else if (row.source === "text") {
      valueInputRef.current?.focus();
    } else if (row.source === "secret") {
      // Focusing the combobox trigger opens SearchableSelect (non-pointer focus).
      valueCellRef.current?.querySelector<HTMLElement>("[role=combobox]")?.focus();
    } else {
      valueCellRef.current?.querySelector<HTMLElement>("select,input")?.focus();
    }
    onFocusConsumed();
  }, [focusRequest, onFocusConsumed, row.source]);

  // Auto-expire the 5s "Undo" affordance after a Secret→Text switch (§6.3).
  useEffect(() => {
    if (!undoPrev) return;
    const handle = window.setTimeout(() => setUndoPrev(null), 5000);
    return () => window.clearTimeout(handle);
  }, [undoPrev]);

  function switchSource(next: RowSource) {
    if (next === "user_secret") {
      if (row.source === "user_secret") return;
      onPatch({ source: "user_secret", secretId: "", version: "latest" });
      window.setTimeout(() => valueCellRef.current?.querySelector<HTMLElement>("select,input")?.focus(), 0);
      return;
    }

    const plan = planSourceSwitch(row, next);
    switch (plan.kind) {
      case "noop":
        return;
      case "open-store": {
        // Defer to the next macrotask so the source DropdownMenu fully closes
        // (and Radix returns focus to its trigger) before we open the anchored
        // store-as-secret popover. Opening synchronously inside the menu-item's
        // onSelect lets the menu's focus-return land as a `focusOutside` /
        // `interactOutside` on the just-opened popover, which Radix would
        // immediately dismiss — the same nested open-while-closing race as the
        // ⋯ path and the picker's + Create item (PAP-12476/12477/12478).
        const { name, value } = plan;
        window.setTimeout(() => setSecretPopover({ mode: "store", name, value }), 0);
        return;
      }
      case "to-secret":
        onPatch({ source: "secret", userSecretKey: "", required: true });
        // Auto-open the picker.
        window.setTimeout(() => {
          valueCellRef.current?.querySelector<HTMLElement>("[role=combobox]")?.focus();
        }, 0);
        return;
      case "to-text":
        if (plan.undoFrom) setUndoPrev(plan.undoFrom);
        onPatch({ source: "text", secretId: "", userSecretKey: "", required: true, version: "latest" });
        window.setTimeout(() => valueInputRef.current?.focus(), 0);
        return;
    }
  }

  async function submitSecretPopover(name: string, value: string) {
    const created = await onCreateSecret(name, value);
    onPatch({
      source: "secret",
      secretId: created.id,
      userSecretKey: "",
      required: true,
      version: "latest",
      textValue: "",
    });
    onToast(`Secret ${created.name} created`);
    setSecretPopover(null);
  }

  function openStoreAsSecret() {
    const name = secretNameFromKey(row.name) || "secret";
    const { textValue } = row;
    window.setTimeout(() => setSecretPopover({ mode: "store", name, value: textValue }), 0);
  }

  const sourceLabel =
    row.source === "text"
      ? "Text value"
      : row.source === "secret"
        ? "Company secret reference"
        : "User secret reference";
  const nameErrorId = `${row.id}-name-error`;
  const healthId = `${row.id}-health`;
  const isDirty = dirtyFields.name || dirtyFields.value;

  const versions = boundSecret ? Math.max(0, boundSecret.latestVersion) : 0;
  const versionTagLabel = row.version === "latest" ? "latest" : `v${row.version}`;
  const versionPinned = row.version !== "latest";

  return (
    <div
      className={cn(
        "group/row grid grid-cols-(--gtc-13) items-start gap-x-1.5 gap-y-1 rounded-md px-1 py-1",
        "@[40rem]/env:grid-cols-(--gtc-14) @[40rem]/env:items-center",
        isDirty && "bg-amber-500/[0.06] ring-1 ring-amber-500/20",
      )}
    >
      {/* Name cell — mobile col 1 / desktop col 1 */}
      <div className="col-start-1 row-start-1 min-w-0 @[40rem]/env:row-start-1 @[40rem]/env:self-start">
        <input
          ref={nameInputRef}
          className={cn(
            nameInputClass,
            dirtyFields.name && "border-amber-500/70 bg-amber-500/10 focus-visible:ring-amber-500/40",
            showNameIssue && nameIssue?.level === "error" && "border-destructive focus-visible:ring-destructive/40",
            showNameIssue && nameIssue?.level === "warn" && "border-amber-500 focus-visible:ring-amber-500/40",
          )}
          placeholder="KEY"
          value={row.name}
          spellCheck={false}
          disabled={disabled}
          aria-label="Variable name"
          aria-invalid={showNameIssue && nameIssue?.level === "error" ? true : undefined}
          aria-describedby={showNameIssue && nameIssue ? nameErrorId : undefined}
          onChange={(event) => onPatch({ name: event.target.value })}
          onBlur={onNameBlur}
          onPaste={(event) => {
            if (row.name) return;
            const text = event.clipboardData.getData("text");
            if (onNamePaste(text)) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (row.source === "text") valueInputRef.current?.focus();
              else valueCellRef.current?.querySelector<HTMLElement>("[role=combobox],select,input")?.focus();
            }
          }}
        />
      </div>

      {/* Value cell — mobile full-width line 2 / desktop col 2 */}
      <div className="col-span-2 col-start-1 row-start-2 min-w-0 @[40rem]/env:col-span-1 @[40rem]/env:col-start-2 @[40rem]/env:row-start-1">
        <Popover
          open={secretPopover !== null}
          onOpenChange={(open) => {
            if (!open) setSecretPopover(null);
          }}
        >
          <PopoverAnchor asChild>
            <div
              ref={valueCellRef}
              className={cn(
                "relative flex items-stretch overflow-hidden rounded-md border border-border bg-transparent focus-within:ring-2 focus-within:ring-ring/40",
                dirtyFields.value && "border-amber-500/70 bg-amber-500/10 focus-within:ring-amber-500/40",
                disabled && "opacity-60",
              )}
            >
              {/* Source switch (inside the field) */}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild disabled={disabled}>
                      <button
                        type="button"
                        aria-label="Value source"
                        className="flex shrink-0 items-center gap-0.5 border-r border-border px-2 text-muted-foreground hover:bg-accent/50 disabled:pointer-events-none"
                      >
                        {row.source === "text" ? (
                          <TypeIcon className="size-3.5" />
                        ) : row.source === "secret" ? (
                          <KeyRound className="size-3.5" />
                        ) : (
                          <UserRound className="size-3.5" />
                        )}
                        <ChevronDown className="size-3 opacity-60" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">{sourceLabel}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => switchSource("text")}>
                    <span className="text-sm">Text value</span>
                    <span className="text-(length:--text-micro) text-muted-foreground">Store the value inline as plain text.</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => switchSource("secret")}>
                    <span className="text-sm">Company secret</span>
                    <span className="text-(length:--text-micro) text-muted-foreground">Resolve a stored company secret at run start.</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => switchSource("user_secret")}>
                    <span className="text-sm">User secret</span>
                    <span className="text-(length:--text-micro) text-muted-foreground">
                      Resolve the responsible user&apos;s own value at run start.
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {row.source === "text" ? (
                <>
                  <input
                    ref={valueInputRef}
                    className={valueTextInputClass}
                    placeholder="value"
                    value={row.textValue}
                    type={sensitive ? "password" : "text"}
                    spellCheck={false}
                    disabled={disabled}
                    aria-label="Variable value"
                    onChange={(event) => onPatch({ textValue: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && isLast) {
                        event.preventDefault();
                        onEnterInValueLast();
                      }
                    }}
                  />
                  {sensitive ? (
                    <div className="flex shrink-0 items-stretch border-l border-border">
                      <button
                        type="button"
                        onClick={openStoreAsSecret}
                        disabled={disabled}
                        className="flex items-center gap-1 px-2 text-(length:--text-micro) text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                        title="This value looks sensitive — store it as a secret"
                      >
                        <ShieldAlert className="size-3.5" />
                        <span className="hidden @[30rem]/env:inline">Store as secret</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onPatch({ sensitiveDismissed: true })}
                        disabled={disabled}
                        aria-label="Dismiss sensitive-value suggestion"
                        title="Dismiss — keep this value as plain text"
                        className="flex items-center px-1.5 text-amber-700/60 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400/60 dark:hover:text-amber-400"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ) : null}
                </>
              ) : row.source === "secret" ? (
                <div className="relative min-w-0 flex-1">
                  <SecretPicker
                    secretId={row.secretId}
                    secrets={secrets}
                    recentlyUsedSecrets={recentlyUsedSecrets}
                    disabled={disabled}
                    onSelect={(id) => onPatch({ secretId: id, version: "latest" })}
                    onCreateNew={(query) =>
                      setSecretPopover({ mode: "create", name: secretNameFromKey(query) || query.trim(), value: "" })
                    }
                    triggerClassName={cn(
                      "rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0",
                      boundSecret && boundSecret.status === "active" && "pr-24 has-[>svg]:!pr-24",
                    )}
                  />
                  {boundSecret && boundSecret.status === "active" ? (
                    <Popover open={versionOpen} onOpenChange={setVersionOpen}>
                      <PopoverAnchor asChild>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setVersionOpen((prev) => !prev);
                          }}
                          aria-label="Version"
                          className={cn(
                            "absolute right-8 top-1/2 z-10 -translate-y-1/2 rounded px-1.5 py-0.5 text-(length:--text-nano) font-medium",
                            versionPinned
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                              : "text-muted-foreground hover:bg-accent",
                          )}
                        >
                          {versionTagLabel}
                        </button>
                      </PopoverAnchor>
                      <PopoverContent align="end" className="w-44 p-1" role="radiogroup" aria-label="Secret version">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={row.version === "latest"}
                          onClick={() => {
                            onPatch({ version: "latest" });
                            setVersionOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-accent",
                            row.version === "latest" && "font-medium",
                          )}
                        >
                          latest <span className="text-(length:--text-micro) text-muted-foreground">(recommended)</span>
                        </button>
                        {Array.from({ length: versions }, (_, idx) => versions - idx)
                          .filter((v) => v > 0)
                          .map((v) => (
                            <button
                              key={v}
                              type="button"
                              role="radio"
                              aria-checked={row.version === v}
                              onClick={() => {
                                onPatch({ version: v });
                                setVersionOpen(false);
                              }}
                              className={cn(
                                "flex w-full items-center rounded px-2 py-1.5 text-sm hover:bg-accent",
                                row.version === v && "font-medium text-amber-700 dark:text-amber-400",
                              )}
                            >
                              v{v}
                            </button>
                          ))}
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              ) : (
                <div className="grid min-w-0 flex-1 grid-cols-(--gtc-13)">
                  {userSecretsEnabled ? (
                    <select
                      aria-label="User secret"
                      value={row.userSecretKey}
                      disabled={disabled}
                      onChange={(event) => {
                        const key = event.target.value;
                        const definition = userSecretDefinitions?.find((candidate) => candidate.key === key);
                        onPatch({
                          userSecretKey: key,
                          ...(definition && !row.name.trim() ? { name: definition.key.toUpperCase() } : {}),
                        });
                      }}
                      className="min-w-0 bg-transparent px-2 py-1.5 text-sm font-mono outline-none disabled:pointer-events-none"
                    >
                      <option value="">Select user secret...</option>
                      {row.userSecretKey && !userSecretDefinitions?.some((definition) => definition.key === row.userSecretKey) ? (
                        <option value={row.userSecretKey}>Unknown ({row.userSecretKey})</option>
                      ) : null}
                      {(userSecretDefinitions ?? []).map((definition) => (
                        <option key={definition.id} value={definition.key}>
                          {definition.name}
                          {definition.status !== "active" ? ` (${definition.status})` : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={valueTextInputClass}
                      placeholder="user-secret key"
                      value={row.userSecretKey}
                      spellCheck={false}
                      disabled={disabled}
                      aria-label="User secret key"
                      onChange={(event) => onPatch({ userSecretKey: event.target.value })}
                    />
                  )}
                  <select
                    aria-label="Requirement"
                    value={row.required ? "required" : "optional"}
                    disabled={disabled}
                    onChange={(event) => onPatch({ required: event.target.value === "required" })}
                    className="border-l border-border bg-transparent px-2 py-1.5 text-xs font-medium text-muted-foreground outline-none disabled:pointer-events-none"
                  >
                    <option value="required">Required</option>
                    <option value="optional">Optional</option>
                  </select>
                </div>
              )}
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            className="w-auto p-3"
            onInteractOutside={(event) => {
              // Keep the create/store popover open when the dismissal
              // originates from inside the value cell — i.e. the picker's
              // combobox trigger or the source-switch dropdown trigger, both
              // anchored here. Those controls close by returning focus to
              // themselves; because the value cell is this popover's *anchor*
              // (outside its content), Radix reads that focus-return as a
              // `focusOutside` and would dismiss the just-opened popover.
              //
              // The picker's close animation can delay its focus-return past
              // any single macrotask, so the `setTimeout(0)` open-defers
              // (SearchableSelect / switchSource) cannot reliably win the race
              // (PAP-12492). Guarding the interaction here makes the create /
              // store popover survive that focus-return deterministically,
              // independent of timing. Dismissals from anywhere *outside* the
              // value cell (real outside clicks, Escape) are untouched.
              const target = event.detail.originalEvent.target as Node | null;
              if (target && valueCellRef.current?.contains(target)) {
                event.preventDefault();
              }
            }}
          >
            {secretPopover?.mode === "store" ? (
              <ConvertToSecretPopover
                initialName={secretPopover.name}
                initialValue={secretPopover.value}
                existingSecretNames={secrets.map((s) => s.name)}
                onCancel={() => setSecretPopover(null)}
                onSubmit={submitSecretPopover}
              />
            ) : secretPopover?.mode === "create" ? (
              <CreateSecretPopover
                initialName={secretPopover.name}
                initialValue={secretPopover.value}
                existingSecretNames={secrets.map((s) => s.name)}
                onCancel={() => setSecretPopover(null)}
                onSubmit={submitSecretPopover}
              />
            ) : null}
          </PopoverContent>
        </Popover>

        {/* Inline secret-health message */}
        {health ? (
          <p
            id={healthId}
            role="status"
            className={cn(
              "mt-0.5 text-(length:--text-micro)",
              health.level === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
            )}
          >
            {health.message}
          </p>
        ) : null}

        {/* 5s undo after Secret→Text */}
        {undoPrev ? (
          <p className="mt-0.5 inline-flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            Reverted to text —{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={() => {
                onPatch({ source: "secret", secretId: undoPrev.secretId, version: undoPrev.version, textValue: "" });
                setUndoPrev(null);
              }}
            >
              Undo
            </button>
          </p>
        ) : null}
      </div>

      {showNameIssue && nameIssue ? (
        <p
          id={nameErrorId}
          className={cn(
            "col-span-2 col-start-1 row-start-3 min-w-0 text-(length:--text-micro) @[40rem]/env:col-span-2 @[40rem]/env:row-start-2",
            nameIssue.level === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
          )}
        >
          {nameIssue.message}
        </p>
      ) : null}

      {/* Actions cell — mobile col 2 line 1 / desktop col 3 */}
      <div className="col-start-2 row-start-1 flex items-center justify-end gap-0.5 self-start @[40rem]/env:col-start-3 @[40rem]/env:self-center">
        {row.source === "text" && !sensitive && (row.name.trim() || row.textValue) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <button
                type="button"
                aria-label="More actions"
                className="rounded p-1 text-muted-foreground opacity-100 hover:bg-accent hover:text-foreground @[40rem]/env:opacity-0 @[40rem]/env:group-hover/row:opacity-100 @[40rem]/env:group-focus-within/row:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  // Defer to the next macrotask so this menu fully closes (and
                  // Radix returns focus to the ⋯ trigger, which sits outside the
                  // row's Popover) before we open the anchored store-as-secret
                  // popover. Opening synchronously lets the menu's focus-return
                  // land as a `focusOutside` on the just-opened popover, which
                  // Radix would immediately dismiss — the same nested open-while-
                  // closing race as the picker's + Create item (PAP-12476/12477).
                  window.setTimeout(openStoreAsSecret, 0);
                }}
              >
                Store as secret…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${row.name.trim() || "variable"}`}
          className="rounded p-1 text-muted-foreground opacity-100 hover:bg-destructive/10 hover:text-destructive @[40rem]/env:opacity-0 @[40rem]/env:group-hover/row:opacity-100 @[40rem]/env:group-focus-within/row:opacity-100"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
