import { useId, useMemo, useRef, useState } from "react";
import {
  Camera,
  LoaderCircle,
  Trash2,
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
  imageClassName?: string;
}

export function AgentIcon({ icon, avatarUrl, className, imageClassName }: AgentIconProps) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={cn("h-full w-full object-cover", className, imageClassName)}
        draggable={false}
      />
    );
  }
  const Icon = getAgentIcon(icon);
  return <Icon className={className} />;
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  avatarUrl?: string | null;
  onChange: (icon: string) => void;
  onAvatarUpload?: (file: File) => void;
  onAvatarRemove?: () => void;
  isUploadingAvatar?: boolean;
  isRemovingAvatar?: boolean;
  children: React.ReactNode;
}

export function AgentIconPicker({
  value,
  avatarUrl,
  onChange,
  onAvatarUpload,
  onAvatarRemove,
  isUploadingAvatar = false,
  isRemovingAvatar = false,
  children,
}: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const entries = AGENT_ICON_NAMES.map((name) => [name, AGENT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        {onAvatarUpload ? (
          <div className="mb-3 flex items-center gap-2 border-b border-border pb-3">
            <input
              ref={fileInputRef}
              id={inputId}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              disabled={isUploadingAvatar || isRemovingAvatar}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                onAvatarUpload(file);
              }}
            />
            <button
              type="button"
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingAvatar || isRemovingAvatar}
            >
              {isUploadingAvatar ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              {avatarUrl ? "Change image" : "Upload image"}
            </button>
            {avatarUrl && onAvatarRemove ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                onClick={onAvatarRemove}
                disabled={isUploadingAvatar || isRemovingAvatar}
                aria-label="Remove image"
                title="Remove image"
              >
                {isRemovingAvatar ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            ) : null}
          </div>
        ) : null}
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
                setOpen(false);
                setSearch("");
              }}
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded hover:bg-accent transition-colors",
                (value ?? DEFAULT_ICON) === name && "bg-accent ring-1 ring-primary"
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
      </PopoverContent>
    </Popover>
  );
}
