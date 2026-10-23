package ai.paperclip.dashboard.data

import kotlinx.serialization.Serializable

// Types behind the side-menu sections (mirrors ui/src/api and packages/shared/src/types).

@Serializable
data class SidebarBadges(
    val inbox: Int = 0,
    val approvals: Int = 0,
    val failedRuns: Int = 0,
    val joinRequests: Int = 0,
)

@Serializable
data class Project(
    val id: String,
    val name: String = "",
    val description: String? = null,
    val status: String = "",
    val color: String? = null,
    val leadAgentId: String? = null,
    val targetDate: String? = null,
    val archivedAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class Goal(
    val id: String,
    val title: String = "",
    val description: String? = null,
    val level: String = "",
    val status: String = "",
    val parentId: String? = null,
    val ownerAgentId: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class RoutineTriggerSummary(
    val id: String,
    val kind: String = "",
    val label: String? = null,
    val enabled: Boolean = true,
    val cronExpression: String? = null,
    val nextRunAt: String? = null,
    val lastFiredAt: String? = null,
)

@Serializable
data class RoutineRunSummary(
    val id: String,
    val status: String = "",
    val createdAt: String? = null,
    val triggeredAt: String? = null,
    val linkedIssue: RoutineIssueRef? = null,
)

@Serializable
data class RoutineIssueRef(val id: String, val identifier: String? = null, val title: String = "", val status: String = "")

@Serializable
data class Routine(
    val id: String,
    val title: String = "",
    val description: String? = null,
    val status: String = "",
    val assigneeAgentId: String? = null,
    val projectId: String? = null,
    val triggers: List<RoutineTriggerSummary> = emptyList(),
    val lastRun: RoutineRunSummary? = null,
    val updatedAt: String? = null,
)

@Serializable
data class DecisionOption(val id: String, val label: String? = null, val title: String? = null, val description: String? = null)

@Serializable
data class Decision(
    val id: String,
    val title: String = "",
    val body: String = "",
    val status: String = "open",
    val originAgentId: String? = null,
    val originIssueId: String? = null,
    val options: List<DecisionOption> = emptyList(),
    val chosenOptionId: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class CostSummary(
    val spendCents: Long = 0,
    val budgetCents: Long = 0,
    val utilizationPercent: Double = 0.0,
    val eventCount: Int = 0,
    val pendingRunCount: Int = 0,
    val pricingComplete: Boolean = true,
)

@Serializable
data class CostByAgent(
    val agentId: String? = null,
    val agentName: String? = null,
    val agentStatus: String? = null,
    val costCents: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val eventCount: Int = 0,
)

@Serializable
data class CostByProject(
    val projectId: String? = null,
    val projectName: String? = null,
    val costCents: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
)

@Serializable
data class OrgNode(
    val id: String,
    val name: String = "",
    val role: String = "",
    val status: String = "",
    val reports: List<OrgNode> = emptyList(),
)

@Serializable
data class SearchResult(
    val id: String,
    val type: String = "",
    val title: String = "",
    val href: String = "",
    val sourceLabel: String? = null,
    val snippet: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class SearchResponse(val results: List<SearchResult> = emptyList())
