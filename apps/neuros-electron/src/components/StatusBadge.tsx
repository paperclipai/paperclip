interface StatusBadgeProps {
  tone: "neutral" | "success" | "warning" | "danger";
  label: string;
}

export function StatusBadge({ tone, label }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}
