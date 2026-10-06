import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { cn } from "@/lib/utils";

const brandMarks: Record<string, { src: string; dark?: string }> = {
  claude_local: { src: "/brands/claude-color.svg" },
  codex_local: { src: "/brands/codex-color.svg" },
  gemini_local: { src: "/brands/adapters/gemini-color.svg" },
  kimi_local: {
    src: "/brands/adapters/kimi-color-light.svg",
    dark: "/brands/adapters/kimi-color.svg",
  },
  ...Object.fromEntries(
    [
      ["cursor", "cursor"],
      ["cursor_cloud", "cursor"],
      ["grok_local", "grok"],
      ["hermes_local", "hermesagent"],
      ["hermes_gateway", "hermesagent"],
      ["pi_local", "pi"],
    ].map(([type, icon]) => [
      type,
      {
        src: `/brands/adapters/${icon}.svg`,
        dark: `/brands/adapters/${icon}-dark.svg`,
      },
    ]),
  ),
};
export function AdapterMark({
  type,
  className = "size-6",
}: {
  type: string;
  className?: string;
}) {
  const Icon = getAdapterDisplay(type).icon;
  const mark = brandMarks[type];
  if (!mark) return <Icon className={className} />;
  return (
    <>
      <img
        src={mark.src}
        className={cn(
          "shrink-0 object-contain",
          mark.dark && "dark:hidden",
          className,
        )}
        alt=""
      />
      {mark.dark && (
        <img
          src={mark.dark}
          className={cn("hidden shrink-0 object-contain dark:block", className)}
          alt=""
        />
      )}
    </>
  );
}
