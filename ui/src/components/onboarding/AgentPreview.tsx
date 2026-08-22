import { motion } from "motion/react";
import { PREVIEW_REVEAL_DURATION, STEP_EASE } from "./onboarding-motion";

/**
 * Name/role preview under the capsule. Collapsed to zero height until an
 * identity exists, so the step opens compact; on selection the block grows to
 * full height — the centered card re-centers each frame, so the capsule slides
 * up into place — while the labels fade in without moving. Slide and fade share
 * one duration; the fade starts after 25% of it. Both lines keep fixed heights
 * once visible, so typing a name afterwards never shifts the layout again.
 */
export function AgentPreview({
  agentName,
  agentRole,
}: {
  agentName: string;
  agentRole: string;
}) {
  const previewVisible = Boolean(agentName || agentRole);
  return (
    <motion.div
      className="overflow-hidden"
      initial={false}
      animate={{ height: previewVisible ? "auto" : 0 }}
      transition={{ duration: PREVIEW_REVEAL_DURATION, ease: STEP_EASE }}
    >
      <motion.div
        className="mt-1 flex flex-col items-center gap-1"
        initial={false}
        animate={{ opacity: previewVisible ? 1 : 0 }}
        transition={{
          duration: PREVIEW_REVEAL_DURATION,
          ease: STEP_EASE,
          delay: previewVisible ? PREVIEW_REVEAL_DURATION * 0.25 : 0,
        }}
      >
        <span className="flex h-6 items-center text-base font-semibold tracking-tight text-foreground">
          {agentName || " "}
        </span>
        <span className="flex h-4 items-center text-xs text-muted-foreground">
          {agentRole || " "}
        </span>
      </motion.div>
    </motion.div>
  );
}
