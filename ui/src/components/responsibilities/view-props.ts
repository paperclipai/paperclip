import type { ResponsibilitiesHomeLayoutProps } from "./ResponsibilitiesHomeLayout";
import type { ResponsibilityPageLayoutProps } from "./ResponsibilityPageLayout";

/**
 * A simpler Dashboard view: the full layout's props, plus adding an area
 * (the Outline keeps it) and a way to the proposals review, which lives in
 * the full layout.
 */
export interface DashboardViewProps extends ResponsibilitiesHomeLayoutProps {
  onAddArea: () => void;
  onReviewProposals: () => void;
}

/**
 * A simpler responsibility page view: the full layout's props, plus a way to
 * review it when it is proposed, and the page's one way into editing the bar.
 */
export interface ResponsibilityViewProps extends ResponsibilityPageLayoutProps {
  onReviewProposal: () => void;
  /** Open the bar-editing flow the full layout uses. Absent where the bar cannot be edited. */
  onEditBar?: () => void;
}
