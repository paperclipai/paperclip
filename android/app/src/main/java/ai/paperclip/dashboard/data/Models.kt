package ai.paperclip.dashboard.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Mirrors the subset of packages/shared/src/types the dashboard renders.
// Unknown fields are ignored by the decoder, so server additions never break the app.

@Serializable
data class Company(
    val id: String,
    val name: String,
    val description: String? = null,
    val status: String = "active",
    val issuePrefix: String = "",
    val budgetMonthlyCents: Long = 0,
    val spentMonthlyCents: Long = 0,
    val requireBoardApprovalForNewAgents: Boolean = false,
)

@Serializable
data class DashboardSummary(
    val companyId: String = "",
    val agents: AgentCounts = AgentCounts(),
    val tasks: TaskCounts = TaskCounts(),
    val costs: Costs = Costs(),
    val pendingApprovals: Int = 0,
    val budgets: BudgetCounts = BudgetCounts(),
    val runActivity: List<RunActivityDay> = emptyList(),
)

@Serializable
data class AgentCounts(val active: Int = 0, val running: Int = 0, val paused: Int = 0, val error: Int = 0)

@Serializable
data class TaskCounts(val open: Int = 0, val inProgress: Int = 0, val blocked: Int = 0, val done: Int = 0)

@Serializable
data class Costs(
    val monthSpendCents: Long = 0,
    val monthBudgetCents: Long = 0,
    val monthUtilizationPercent: Double = 0.0,
)

@Serializable
data class BudgetCounts(
    val activeIncidents: Int = 0,
    val pendingApprovals: Int = 0,
    val pausedAgents: Int = 0,
    val pausedProjects: Int = 0,
)

@Serializable
data class RunActivityDay(
    val date: String,
    val succeeded: Int = 0,
    val failed: Int = 0,
    val recovered: Int = 0,
    val other: Int = 0,
    val total: Int = 0,
)

@Serializable
data class Issue(
    val id: String,
    val companyId: String = "",
    val identifier: String? = null,
    val title: String = "",
    val description: String? = null,
    val status: String = "todo",
    val priority: String = "medium",
    val projectId: String? = null,
    val parentId: String? = null,
    val assigneeAgentId: String? = null,
    val assigneeUserId: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val goalId: String? = null,
    val labelIds: List<String> = emptyList(),
    val labels: List<IssueLabel> = emptyList(),
    val blockedBy: List<IssueRelation> = emptyList(),
    val blocks: List<IssueRelation> = emptyList(),
    val isUnreadForMe: Boolean = false,
    val descriptionTruncated: Boolean = false,
    val activeRun: ActiveRunRef? = null,
    val lastActivityAt: String? = null,
)

@Serializable
data class IssueLabel(val id: String, val name: String = "", val color: String = "")

/** Issue summary used in blocked-by / blocks relations. */
@Serializable
data class IssueRelation(
    val id: String,
    val identifier: String? = null,
    val title: String = "",
    val status: String = "todo",
    val priority: String = "medium",
    val assigneeAgentId: String? = null,
)

@Serializable
data class ActiveRunRef(
    val id: String,
    val status: String = "",
    val agentId: String? = null,
    val startedAt: String? = null,
)

@Serializable
data class IssueComment(
    val id: String,
    val issueId: String = "",
    val authorType: String? = null,
    val authorAgentId: String? = null,
    val authorUserId: String? = null,
    val body: String = "",
    val createdAt: String? = null,
    val deletedAt: String? = null,
)

@Serializable
data class Agent(
    val id: String,
    val companyId: String = "",
    val name: String = "",
    val role: String = "",
    val title: String? = null,
    val status: String = "idle",
    val adapterType: String = "",
    val capabilities: String? = null,
    val budgetMonthlyCents: Long = 0,
    val spentMonthlyCents: Long = 0,
    val pauseReason: String? = null,
    val errorReason: String? = null,
    val lastHeartbeatAt: String? = null,
    val reportsTo: String? = null,
    val urlKey: String? = null,
)

@Serializable
data class Approval(
    val id: String,
    val companyId: String = "",
    val type: String = "",
    val status: String = "pending",
    val requestedByAgentId: String? = null,
    val requestedByUserId: String? = null,
    val payload: JsonObject = JsonObject(emptyMap()),
    val decisionNote: String? = null,
    val decidedAt: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class ApprovalComment(
    val id: String,
    val authorAgentId: String? = null,
    val authorUserId: String? = null,
    val body: String = "",
    val createdAt: String? = null,
)

@Serializable
data class ActivityEvent(
    val id: String,
    val actorType: String = "system",
    val actorId: String = "",
    val action: String = "",
    val entityType: String = "",
    val entityId: String = "",
    val agentId: String? = null,
    val details: JsonObject? = null,
    val createdAt: String? = null,
)

val ISSUE_STATUSES = listOf("backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled")
val ISSUE_PRIORITIES = listOf("critical", "high", "medium", "low")
val APPROVAL_STATUSES = listOf("pending", "revision_requested", "approved", "rejected", "cancelled")
