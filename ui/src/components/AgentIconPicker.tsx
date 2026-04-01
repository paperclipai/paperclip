import { useState, useMemo, useCallback } from "react";
import {
  type LucideIcon,
} from "lucide-react";
import { AGENT_ICON_NAMES, type AgentIconName } from "@paperclipai/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AGENT_ICONS, getAgentIcon } from "../lib/agent-icons";

const DEFAULT_ICON: AgentIconName = "bot";

interface AgentIconProps {
  icon: string | null | undefined;
  avatarUrl?: string | null;
  className?: string;
}

export function AgentIcon({ icon, avatarUrl, className }: AgentIconProps) {
  const [imgError, setImgError] = useState(false);
  const handleError = useCallback(() => setImgError(true), []);

  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={cn(className, "rounded-full object-cover")}
        onError={handleError}
      />
    );
  }
  const Icon = getAgentIcon(icon);
  return <Icon className={className} />;
}

const AVATAR_STYLES = [
  { id: "notionists", label: "Notionists" },
  { id: "avataaars", label: "Avataaars" },
  { id: "bottts", label: "Robots" },
  { id: "lorelei", label: "Lorelei" },
  { id: "micah", label: "Micah" },
  { id: "open-peeps", label: "Open Peeps" },
  { id: "personas", label: "Personas" },
  { id: "pixel-art", label: "Pixel Art" },
  { id: "thumbs", label: "Thumbs" },
] as const;

function buildAvatarUrl(style: string, seed: string): string {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}&size=128`;
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  avatarUrl?: string | null;
  agentName?: string;
  onChange: (icon: string) => void;
  onAvatarChange?: (url: string | null) => void;
  children: React.ReactNode;
}

export function AgentIconPicker({ value, avatarUrl, agentName, onChange, onAvatarChange, children }: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"icons" | "avatar">(avatarUrl ? "avatar" : "icons");
  const [selectedStyle, setSelectedStyle] = useState("notionists");

  const filtered = useMemo(() => {
    const entries = AGENT_ICON_NAMES.map((name) => [name, AGENT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);

  const seed = agentName || "agent";
  const previewUrl = buildAvatarUrl(selectedStyle, seed);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            className={cn(
              "flex-1 px-3 py-2 text-xs font-medium transition-colors",
              tab === "icons" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab("icons")}
          >
            Icons
          </button>
          {onAvatarChange && (
            <button
              className={cn(
                "flex-1 px-3 py-2 text-xs font-medium transition-colors",
                tab === "avatar" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab("avatar")}
            >
              Avatar
            </button>
          )}
        </div>

        {tab === "icons" ? (
          <div className="p-3">
            <Input
              placeholder="Search icons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-2 h-8 text-sm"
              autoFocus
            />
            <div className="grid grid-cols-7 gap-1 max-h-48 overflow-y-auto">
              {filtered.map(([name, Icon]) => (
                <button
                  key={name}
                  onClick={() => {
                    onChange(name);
                    onAvatarChange?.(null);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "flex items-center justify-center h-8 w-8 rounded hover:bg-accent transition-colors",
                    !avatarUrl && (value ?? DEFAULT_ICON) === name && "bg-accent ring-1 ring-primary",
                  )}
                  title={name}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="col-span-7 text-xs text-muted-foreground text-center py-2">No icons match</p>
              )}
            </div>
          </div>
        ) : (
          <div className="p-3">
            {/* Preview */}
            <div className="flex justify-center mb-3">
              <img
                src={previewUrl}
                alt="Preview"
                className="h-20 w-20 rounded-full border-2 border-border"
              />
            </div>

            {/* Style grid */}
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {AVATAR_STYLES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedStyle(s.id)}
                  className={cn(
                    "flex flex-col items-center gap-1 p-2 rounded-md text-[11px] transition-colors",
                    selectedStyle === s.id
                      ? "bg-accent ring-1 ring-primary text-foreground"
                      : "hover:bg-accent/50 text-muted-foreground",
                  )}
                >
                  <img
                    src={buildAvatarUrl(s.id, seed)}
                    alt={s.label}
                    className="h-8 w-8 rounded-full"
                  />
                  {s.label}
                </button>
              ))}
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onAvatarChange?.(previewUrl);
                  setOpen(false);
                }}
                className="flex-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Apply Avatar
              </button>
              {avatarUrl && (
                <button
                  onClick={() => {
                    onAvatarChange?.(null);
                    setOpen(false);
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
