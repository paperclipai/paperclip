// LET-503 round-3 — `AgentAvatar` is the visual identity primitive
// rendered next to every agent reference: Agents table rows, Builder
// summary card, Org graph nodes, Mission owner chips, Runs actor rows.
//
// Two render modes share the same token so the same agent looks the
// same wherever it appears:
//   - `glyph` mode renders the lucide icon (the default).
//   - `initials` mode renders the two-letter initials in the same tinted
//     well, useful when density is tight (mission chip, runs actor).
// Both modes share the same accent palette derived from the agent id.

import {
  AVATAR_DIAMETER,
  AVATAR_GLYPH_PX,
  AVATAR_INITIALS_FONT_PX,
  getAgentAvatarToken,
  type AgentAvatarToken,
  type AvatarSize,
  type AvatarSubject,
} from "./agent-avatar";

type AgentAvatarVariant = "glyph" | "initials";

export interface AgentAvatarProps {
  subject: AvatarSubject;
  size?: AvatarSize;
  variant?: AgentAvatarVariant;
  // When provided, overrides the token's aria-label. The avatar itself
  // is otherwise `aria-hidden` and the surrounding row provides the
  // accessible name.
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

export function AgentAvatar({
  subject,
  size = "md",
  variant = "glyph",
  ariaLabel,
  className,
  testId,
}: AgentAvatarProps) {
  const token = getAgentAvatarToken(subject);
  const diameter = AVATAR_DIAMETER[size];
  const labelled = Boolean(ariaLabel);
  const computedLabel = ariaLabel ?? token.ariaLabel;

  if (variant === "initials") {
    return (
      <span
        data-testid={testId}
        data-eaos-avatar={token.tone}
        aria-hidden={labelled ? undefined : "true"}
        aria-label={labelled ? computedLabel : undefined}
        role={labelled ? "img" : undefined}
        className={[
          "inline-flex shrink-0 items-center justify-center rounded-full border font-medium tabular-nums",
          className ?? "",
        ].join(" ")}
        style={{
          width: diameter,
          height: diameter,
          backgroundColor: token.accentBg,
          color: token.accentFg,
          borderColor: token.accentBorder,
          fontSize: AVATAR_INITIALS_FONT_PX[size],
          lineHeight: 1,
        }}
      >
        {token.initials}
      </span>
    );
  }

  const Glyph = token.Glyph;
  return (
    <span
      data-testid={testId}
      data-eaos-avatar={token.tone}
      aria-hidden={labelled ? undefined : "true"}
      aria-label={labelled ? computedLabel : undefined}
      role={labelled ? "img" : undefined}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-full border",
        className ?? "",
      ].join(" ")}
      style={{
        width: diameter,
        height: diameter,
        backgroundColor: token.accentBg,
        color: token.accentFg,
        borderColor: token.accentBorder,
      }}
    >
      <Glyph aria-hidden="true" width={AVATAR_GLYPH_PX[size]} height={AVATAR_GLYPH_PX[size]} />
    </span>
  );
}

export type { AgentAvatarToken };
