import type { LucideIcon } from "lucide-react";

export function EmptyState({ icon: Icon, title, description, action }: {
  icon: LucideIcon; title: string; description: string; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20" style={{ color: "var(--fg-muted)" }}>
      <Icon size={48} className="mb-4 opacity-30" />
      <p className="mb-1 text-[15px] font-medium" style={{ color: "var(--fg-secondary)" }}>{title}</p>
      <p className="text-[13px]">{description}</p>
      {action && (
        <button onClick={action.onClick} className="mt-4 rounded-md px-4 py-2 text-[13px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-fg)" }}>
          {action.label}
        </button>
      )}
    </div>
  );
}
