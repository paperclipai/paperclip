import { Card } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

type MetricTone = "accent" | "success" | "neutral";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
  tone?: MetricTone;
}

const toneStyles: Record<MetricTone, { card: string; value: string; icon: string; iconBg: string; sub: string; shadow?: React.CSSProperties }> = {
  accent: {
    card: "bg-gradient-to-br from-accent/[0.08] to-accent/[0.02] border-accent/[0.12] glow-accent",
    value: "text-accent glow-accent-text",
    icon: "text-accent/50",
    iconBg: "bg-accent/10",
    sub: "text-accent/40",
    shadow: { boxShadow: "0 2px 16px rgba(99,102,241,0.06)" },
  },
  success: {
    card: "bg-gradient-to-br from-success/[0.05] to-transparent border-success/[0.08] glow-success",
    value: "text-success",
    icon: "text-success/50",
    iconBg: "bg-success/10",
    sub: "text-success/40",
  },
  neutral: {
    card: "border-default-200/60",
    value: "text-foreground",
    icon: "text-foreground/20",
    iconBg: "bg-default/40",
    sub: "text-foreground/25",
  },
};

export function MetricCard({ icon: Icon, value, label, description, to, onClick, tone = "neutral" }: MetricCardProps) {
  const isClickable = !!(to || onClick);
  const s = toneStyles[tone];

  const inner = (
    <Card
      className={cn(s.card, isClickable && "cursor-pointer hover:opacity-90 transition-opacity")}
      style={s.shadow}
    >
      <Card.Content className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className={cn("text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums", s.value)}>
              {value}
            </p>
            <p className="text-[11px] font-medium text-foreground/40 mt-1.5">
              {label}
            </p>
            {description && (
              <div className={cn("text-[10px] mt-0.5 hidden sm:block", s.sub)}>{description}</div>
            )}
          </div>
          <div className={cn("rounded-xl p-2", s.iconBg)}>
            <Icon className={cn("h-4 w-4", s.icon)} />
          </div>
        </div>
      </Card.Content>
    </Card>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return <div onClick={onClick}>{inner}</div>;
  }

  return inner;
}
