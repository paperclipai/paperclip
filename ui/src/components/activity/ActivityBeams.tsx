import type { ActiveBeam } from "../../hooks/useAgentActivity";

// Draws an animated "beam of light" travelling along a straight line between two
// agent nodes. Rendered as SVG child content: place it INSIDE the parent's
// existing `<g transform=…>` (Org chart) or a plain `<g>` in an overlay `<svg>`
// (Office) so the endpoints stay aligned with the nodes under pan/zoom.

export interface NodePosition {
  x: number;
  y: number;
}
export type NodePositions = Map<string, NodePosition>;

const BEAM_GRADIENT_ID = "live-beam-grad";

export function ActivityBeams({
  nodePositions,
  beams,
}: {
  nodePositions: NodePositions;
  beams: ActiveBeam[];
}) {
  const drawable = beams.filter(
    (beam) => nodePositions.has(beam.fromAgentId) && nodePositions.has(beam.toAgentId),
  );

  return (
    <>
      <defs>
        <linearGradient id={BEAM_GRADIENT_ID} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--hex-22d3ee)" stopOpacity={0} />
          <stop offset="50%" stopColor="var(--hex-22d3ee)" stopOpacity={0.9} />
          <stop offset="100%" stopColor="var(--hex-22d3ee)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {drawable.map((beam) => {
        const from = nodePositions.get(beam.fromAgentId)!;
        const to = nodePositions.get(beam.toAgentId)!;
        return (
          <path
            key={beam.id}
            d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
            fill="none"
            stroke={`url(#${BEAM_GRADIENT_ID})`}
            strokeWidth={3}
            strokeLinecap="round"
            className="live-beam"
            pathLength={100}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </>
  );
}
