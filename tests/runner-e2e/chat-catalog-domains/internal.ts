import { observation, checks } from "./internal-support.js";
import { projectsCases } from "./internal-projects.js";
import { tasksCases } from "./internal-tasks.js";
import { goalsCases } from "./internal-goals.js";
import { documents_artifactsCases } from "./internal-documents-artifacts.js";
import { activityCases } from "./internal-activity.js";
import { inboxSearchCases } from "./internal-inbox-search.js";
import { notificationAudienceCases } from "./internal-notification-audience.js";
import { artifactSearchCases } from "./internal-artifact-search.js";
import { websiteDeliveryCases } from "./internal-website-delivery.js";
import { taskOwnershipCases } from "./internal-task-ownership.js";
import { runHistoryCases } from "./internal-run-history.js";
import { agentFeedbackCases } from "./internal-agent-feedback.js";
import { decisionSearchCases } from "./internal-decision-search.js";
import { designSearchCases } from "./internal-design-search.js";
import { inboxTriageCases } from "./internal-inbox-triage.js";
import { projectDefaultsCases } from "./internal-project-defaults.js";
import { routineAuditCases } from "./internal-routine-audit.js";
import { workTimelineCases } from "./internal-work-timeline.js";
import { archivePartialCases } from "./internal-archive-partial.js";

export const internalChatCatalogCases = [
  ...projectsCases,
  ...tasksCases,
  ...goalsCases,
  ...documents_artifactsCases,
  ...activityCases,
  ...inboxSearchCases,
  ...inboxTriageCases,
  ...designSearchCases,
  ...decisionSearchCases,
  ...agentFeedbackCases,
  ...runHistoryCases,
  ...taskOwnershipCases,
  ...websiteDeliveryCases,
  ...artifactSearchCases,
  ...notificationAudienceCases,
  ...projectDefaultsCases,
  ...routineAuditCases,
  ...workTimelineCases,
  ...archivePartialCases,
];
export function gradeInternal(value: unknown) {
  const o = observation(value);
  const definition = o && internalChatCatalogCases.find(row => row.scenarioId === o.scenarioId);
  if (definition) return definition.grade(value);
  const c = checks(); c.add("implemented-scenario", false, "Missing observation or unimplemented scenario cannot pass."); return c.result();
}
