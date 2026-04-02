import { memo, useId } from "react";
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  type EdgeProps,
} from "@xyflow/react";
import type { GraphEdgeData } from "./types";

function IssueEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const edgeData = data as GraphEdgeData | undefined;
  const kind = edgeData?.kind ?? "parent";
  const isParent = kind === "parent";
  const isLive = edgeData?.targetIsLive ?? false;
  const agentInitial = edgeData?.targetAgentInitial ?? null;
  const agentName = edgeData?.targetAgentName ?? null;

  const filterId = useId();
  const motionPathId = useId();

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: isParent ? 8 : 12,
  });

  const baseStroke = isParent
    ? "var(--color-muted-foreground)"
    : "var(--color-blue-400)";

  return (
    <>
      {isLive && (
        <defs>
          <path id={motionPathId} d={edgePath} />
          <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      )}

      {/* Base edge line */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={baseStroke}
        strokeWidth={isParent ? 1.5 : 1}
        strokeDasharray={isParent ? undefined : "6 4"}
        opacity={isLive ? 0.3 : (isParent ? 0.7 : 0.45)}
        markerEnd={isParent ? markerEnd as string : undefined}
        className="react-flow__edge-path"
      />

      {/* Forward particle: delegation flow (parent → child) — cyan */}
      {isLive && (
        <circle r="3.5" fill="var(--color-cyan-400)" filter={`url(#${filterId})`}>
          <animateMotion
            dur="2.5s"
            repeatCount="indefinite"
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="linear"
          >
            <mpath href={`#${motionPathId}`} />
          </animateMotion>
        </circle>
      )}

      {/* Return particle: status flow (child → parent) — emerald, smaller, offset timing */}
      {isLive && (
        <circle r="2" fill="var(--color-emerald-400)" opacity="0.85">
          <animateMotion
            dur="3s"
            repeatCount="indefinite"
            keyPoints="1;0"
            keyTimes="0;1"
            calcMode="linear"
          >
            <mpath href={`#${motionPathId}`} />
          </animateMotion>
        </circle>
      )}

      {/* Agent avatar at edge midpoint */}
      {isLive && agentInitial && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center justify-center"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={agentName ?? undefined}
          >
            <div className="relative">
              <div className="absolute -inset-1 rounded-full bg-cyan-400/30 animate-[avatarGlow_2s_ease-in-out_infinite]" />
              <div className="relative flex h-6 w-6 items-center justify-center rounded-full border-2 border-cyan-400 bg-card text-[9px] font-bold text-cyan-500 shadow-sm shadow-cyan-400/40">
                {agentInitial}
              </div>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const IssueEdge = memo(IssueEdgeInner);
