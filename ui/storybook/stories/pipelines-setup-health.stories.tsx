import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PipelineHealthWarning } from "@paperclipai/shared";
import { PipelineHealthBar, StageHealthWarnings } from "@/components/PipelineHealthWarnings";
import { PipelineWorkReferences } from "@/components/PipelineWorkReferences";
import { extractWorkReferences } from "@/lib/pipeline-references";

/**
 * Phase 3 (PAP-10941) prosumer surfaces: setup-health warnings on the board
 * header + in stage settings, and typed work references on the case detail
 * panel. These stories are the source for the UXDesigner copy review.
 */

const BOARD_WARNINGS: PipelineHealthWarning[] = [
  {
    code: "paused_agent",
    stageId: "stage-drafting",
    stageKey: "drafting",
    stageName: "Drafting",
    message: "Robin is paused, so this step won't run until they're back. Reassign it if you can't wait.",
  },
  {
    code: "automation_no_instructions",
    stageId: "stage-assets",
    stageKey: "assets",
    stageName: "Assets",
    message: "Assigned to a teammate, but there are no instructions yet. Add instructions so this step doesn't stall.",
  },
  {
    code: "review_no_approver",
    stageId: "stage-final-review",
    stageKey: "final_review",
    stageName: "Final review",
    message: "No approver picked yet, so work will pile up here. Choose who approves.",
  },
  {
    code: "missing_pipeline_reference",
    stageId: "stage-assets",
    stageKey: "assets",
    stageName: "Assets",
    message: "These instructions hand off to a workflow that's been deleted. Point them at one that exists.",
  },
  {
    code: "unset_required_variable",
    stageId: "stage-intake",
    stageKey: "intake",
    stageName: "Intake",
    message: '"Release notes" is empty. Fill it in so this step can run.',
  },
];

/** A busier pipeline whose warning count exceeds the board-bar cap. */
const MANY_BOARD_WARNINGS: PipelineHealthWarning[] = [
  ...BOARD_WARNINGS,
  {
    code: "paused_agent",
    stageId: "stage-edit",
    stageKey: "edit",
    stageName: "Edit",
    message: "Assigned to a teammate who's no longer here. Pick someone else to run this step.",
  },
  {
    code: "missing_stage_reference",
    stageId: "stage-edit",
    stageKey: "edit",
    stageName: "Edit",
    message: 'These instructions hand off to a step that no longer exists in "Content Production". Point them at one that does.',
  },
  {
    code: "review_no_approver",
    stageId: "stage-legal",
    stageKey: "legal",
    stageName: "Legal review",
    message: "Casey is the approver and they're paused, so nothing can be approved until they're back.",
  },
];

const meta: Meta = {
  title: "Pipelines/Setup health",
  parameters: { layout: "padded" },
};
export default meta;

/** The amber warning strip that sits at the top of a pipeline board. */
export const BoardHeaderWarningBar: StoryObj = {
  render: () => (
    <div className="w-full max-w-5xl space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pipeline</p>
          <h1 className="text-2xl font-semibold text-foreground">Content Production</h1>
          <p className="mt-1 text-xs text-muted-foreground">12 total items</p>
        </div>
      </div>
      <PipelineHealthBar warnings={BOARD_WARNINGS} onSelectStage={() => {}} />
    </div>
  ),
};

/** The same bar on a busy pipeline: capped at 5, with a "+n more" trailing line. */
export const BoardHeaderWarningBarCapped: StoryObj = {
  render: () => (
    <div className="w-full max-w-5xl space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Pipeline</p>
          <h1 className="text-2xl font-semibold text-foreground">Content Production</h1>
          <p className="mt-1 text-xs text-muted-foreground">12 total items</p>
        </div>
      </div>
      <PipelineHealthBar warnings={MANY_BOARD_WARNINGS} onSelectStage={() => {}} />
    </div>
  ),
};

/** A single stage's warnings, as shown inside that stage's settings panel. */
export const StageSettingsWarning: StoryObj = {
  render: () => (
    <div className="w-full max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Overview</h2>
      </div>
      <StageHealthWarnings
        warnings={BOARD_WARNINGS.filter((warning) => warning.stageId === "stage-assets")}
      />
    </div>
  ),
};

/** The "Linked work" section on the case detail panel, rendering typed references. */
export const CaseDetailTypedReferences: StoryObj = {
  render: () => {
    const references = extractWorkReferences({
      workspaceRef: { path: "/content/spring-launch/blog", branch: "feature/spring-blog" },
      fields: {
        draft_doc: { kind: "url", url: "https://docs.example.com/spring-blog-draft", label: "Blog draft" },
        hero_image: "https://cdn.example.com/assets/spring-hero.png",
        work_issue: { issueId: "issue-1", identifier: "PAP-9912", title: "Write the spring launch blog" },
      },
    });
    return (
      <div className="w-full max-w-sm rounded-lg border border-border p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Linked work</h3>
        <PipelineWorkReferences references={references} />
      </div>
    );
  },
};
