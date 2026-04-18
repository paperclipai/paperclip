use serde::Serialize;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AppEvent {
    AgentRunStarted { agent_id: String, run_id: String },
    AgentRunCompleted { agent_id: String, run_id: String, status: String },
    AgentRunFailed { agent_id: String, run_id: String, error: String },
    AgentUpdated { agent_id: String },
    IssueCreated { issue_id: String },
    IssueUpdated { issue_id: String },
    RoutineTriggered { routine_id: String, run_id: String },
    WorkflowNodeStarted { run_id: String, node_id: String },
    WorkflowNodeCompleted { run_id: String, node_id: String },
    WorkflowRunCompleted { run_id: String, status: String },
    LocalAiToken { text: String },
    AgentRunLog { run_id: String, stream: String, chunk: String },
}

pub fn emit(app: &tauri::AppHandle, event: AppEvent) {
    let event_name = match &event {
        AppEvent::AgentRunStarted { .. } => "agent-run-started",
        AppEvent::AgentRunCompleted { .. } => "agent-run-completed",
        AppEvent::AgentRunFailed { .. } => "agent-run-failed",
        AppEvent::AgentUpdated { .. } => "agent-updated",
        AppEvent::IssueCreated { .. } => "issue-created",
        AppEvent::IssueUpdated { .. } => "issue-updated",
        AppEvent::RoutineTriggered { .. } => "routine-triggered",
        AppEvent::WorkflowNodeStarted { .. } => "workflow-node-started",
        AppEvent::WorkflowNodeCompleted { .. } => "workflow-node-completed",
        AppEvent::WorkflowRunCompleted { .. } => "workflow-run-completed",
        AppEvent::LocalAiToken { .. } => "local-ai-token",
        AppEvent::AgentRunLog { .. } => "agent-run-log",
    };
    let _ = app.emit(event_name, &event);
}
