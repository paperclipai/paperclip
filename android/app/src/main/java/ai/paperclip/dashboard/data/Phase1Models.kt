package ai.paperclip.dashboard.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Runs, inbox and issue-detail types (mirrors packages/shared/src/types/heartbeat.ts and issue.ts).

/** A heartbeat run. `redacted` rows carry metadata only. */
@Serializable
data class HeartbeatRun(
    val id: String,
    val agentId: String = "",
    val agentName: String? = null,
    val status: String = "",
    val invocationSource: String? = null,
    val triggerDetail: String? = null,
    val issueId: String? = null,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    val createdAt: String? = null,
    val error: String? = null,
    val errorCode: String? = null,
    val exitCode: Int? = null,
    val livenessState: String? = null,
    val lastOutputAt: String? = null,
    val retryOfRunId: String? = null,
    val redacted: Boolean = false,
)

@Serializable
data class RunLogPage(
    val runId: String = "",
    val content: String = "",
    val nextOffset: Long? = null,
)

@Serializable
data class RunEvent(
    val id: Long = 0,
    val seq: Int = 0,
    val eventType: String = "",
    val stream: String? = null,
    val level: String? = null,
    val message: String? = null,
    val createdAt: String? = null,
)

/** Live-update envelope from `/companies/:id/events/ws`. */
@Serializable
data class LiveEvent(
    val type: String = "",
    val companyId: String? = null,
    val createdAt: String? = null,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class IssueDocumentSummary(
    val id: String = "",
    val key: String,
    val title: String? = null,
    val format: String = "markdown",
    val latestRevisionId: String? = null,
    val latestRevisionNumber: Int = 0,
    val lockedAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class IssueDocument(
    val key: String,
    val title: String? = null,
    val format: String = "markdown",
    val body: String = "",
    val latestRevisionId: String? = null,
    val latestRevisionNumber: Int = 0,
    val lockedAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class IssueAttachment(
    val id: String,
    val issueCommentId: String? = null,
    val contentType: String = "",
    val byteSize: Long = 0,
    val originalFilename: String? = null,
    val contentPath: String = "",
    val createdAt: String? = null,
)

/** Agent question / confirmation in an issue thread. Payload shape depends on [kind]. */
@Serializable
data class IssueInteraction(
    val id: String,
    val kind: String = "",
    val status: String = "pending",
    val title: String? = null,
    val summary: String? = null,
    val payload: JsonObject = JsonObject(emptyMap()),
    val result: JsonElement? = null,
    val createdAt: String? = null,
)

@Serializable
data class JoinRequest(
    val id: String,
    val requestType: String = "",
    val status: String = "",
    val requestEmailSnapshot: String? = null,
    val agentName: String? = null,
    val adapterType: String? = null,
    val capabilities: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class InboxDismissal(
    val itemKey: String,
    val kind: String = "dismiss",
    val snoozedUntil: String? = null,
)

/** The five inbox tabs of the web board (ui/src/lib/inbox.ts). */
val INBOX_TABS = listOf("mine", "recent", "unread", "blocked", "all")

/** Statuses the web "mine" tab includes (packages/shared/src/constants.ts). */
const val INBOX_MINE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done"

/** Row from `GET /issues/:id/runs` (keyed by runId, not id). */
@Serializable
data class IssueRun(
    val runId: String,
    val status: String = "",
    val agentId: String = "",
    val invocationSource: String? = null,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    val createdAt: String? = null,
    val errorCode: String? = null,
)
