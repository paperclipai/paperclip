@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.INBOX_TABS
import ai.paperclip.dashboard.data.Issue
import ai.paperclip.dashboard.data.JoinRequest
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

private class InboxData(val issues: List<Issue>, val joins: List<JoinRequest>)

/**
 * Web board Inbox: mine / recent / unread / blocked / all tabs, unread dots, mark read or unread,
 * archive, mark all read, and pending join requests.
 */
@Composable
fun InboxScreen(
    api: PaperclipApi,
    companyId: String,
    agentsById: Map<String, Agent>,
    pendingApprovals: Int,
    onOpen: (Issue) -> Unit,
    onOpenApprovals: () -> Unit,
    onChanged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf("mine") }
    var hidden by remember(companyId, tab) { mutableStateOf(setOf<String>()) }
    var readOverride by remember(companyId, tab) { mutableStateOf(mapOf<String, Boolean>()) }
    var error by remember { mutableStateOf<String?>(null) }
    val state = rememberLoad(companyId, tab) {
        val issues = api.inbox(companyId, tab)
        // Join requests need joins:approve; members without it just don't see them.
        val joins = if (tab == "mine" || tab == "all") runCatching { api.joinRequests(companyId) }.getOrDefault(emptyList()) else emptyList()
        InboxData(
            if (tab == "recent" || tab == "all") issues.sortedByDescending { it.lastActivityAt ?: it.updatedAt } else issues,
            joins,
        )
    }
    LiveEvents(api, companyId) { ev -> if (ev.type == "activity.logged") state.reload() }

    fun act(block: suspend () -> Unit) {
        scope.launch {
            error = runCatching { block() }.exceptionOrNull()?.message
            onChanged()
        }
    }

    Column(Modifier.fillMaxSize()) {
        PrimaryScrollableTabRow(selectedTabIndex = INBOX_TABS.indexOf(tab), edgePadding = 8.dp) {
            INBOX_TABS.forEach { t -> Tab(selected = tab == t, onClick = { tab = t }, text = { Text(humanize(t)) }) }
        }
        error?.let { ErrorBanner(it) }
        LoadedContent(state) { data ->
            val issues = data.issues.filter { it.id !in hidden }
            val unread = issues.filter { readOverride[it.id]?.not() ?: it.isUnreadForMe }
            LazyColumn(Modifier.fillMaxSize()) {
                if (pendingApprovals > 0 && (tab == "mine" || tab == "all")) item(key = "approvals") {
                    OutlinedCard(Modifier.fillMaxWidth().padding(12.dp)) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("$pendingApprovals approval${if (pendingApprovals == 1) "" else "s"} waiting for you", modifier = Modifier.weight(1f))
                            TextButton(onClick = onOpenApprovals) { Text("Review") }
                        }
                    }
                }
                items(data.joins, key = { "join:${it.id}" }) { jr ->
                    JoinRequestCard(jr) { decision -> act { api.decideJoinRequest(companyId, jr.id, decision); state.reload() } }
                }
                if (unread.isNotEmpty()) item(key = "markall") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = {
                            readOverride = readOverride + unread.associate { it.id to true }
                            act { unread.forEach { api.markIssueRead(it.id) } }
                        }) { Text("Mark all read (${unread.size})") }
                    }
                }
                if (issues.isEmpty() && data.joins.isEmpty()) item(key = "empty") { EmptyState("Inbox zero") }
                items(issues, key = { it.id }) { issue ->
                    val isUnread = readOverride[issue.id]?.not() ?: issue.isUnreadForMe
                    InboxRow(
                        issue, agentsById, isUnread,
                        onOpen = {
                            readOverride = readOverride + (issue.id to true)
                            onOpen(issue)
                        },
                        onToggleRead = {
                            readOverride = readOverride + (issue.id to isUnread)
                            act { if (isUnread) api.markIssueRead(issue.id) else api.markIssueUnread(issue.id) }
                        },
                        onArchive = {
                            hidden = hidden + issue.id
                            act { api.archiveFromInbox(issue.id) }
                        },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun InboxRow(
    issue: Issue,
    agentsById: Map<String, Agent>,
    unread: Boolean,
    onOpen: () -> Unit,
    onToggleRead: () -> Unit,
    onArchive: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onOpen, onLongClick = { menu = true })
            .padding(start = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(8.dp).background(
                if (unread) MaterialTheme.colorScheme.tertiary else androidx.compose.ui.graphics.Color.Transparent,
                CircleShape,
            )
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                issue.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                    issue.identifier,
                    issue.assigneeAgentId?.let { agentsById[it]?.name },
                    relativeTime(issue.lastActivityAt ?: issue.updatedAt),
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        StatusPill(issue.status)
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Inbox actions") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(if (unread) "Mark read" else "Mark unread") }, onClick = { menu = false; onToggleRead() })
                DropdownMenuItem(text = { Text("Archive") }, onClick = { menu = false; onArchive() })
            }
        }
    }
}

@Composable
private fun JoinRequestCard(jr: JoinRequest, onDecide: (String) -> Unit) {
    var busy by remember(jr.id) { mutableStateOf(false) }
    OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Join request", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                if (jr.requestType == "agent") "Agent ${jr.agentName ?: ""} (${jr.adapterType ?: "unknown adapter"})"
                else jr.requestEmailSnapshot ?: "Someone",
                style = MaterialTheme.typography.titleSmall,
            )
            jr.capabilities?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3) }
            Text("Requested ${relativeTime(jr.createdAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = !busy, onClick = { busy = true; onDecide("approve") }) { Text("Approve") }
                OutlinedButton(enabled = !busy, onClick = { busy = true; onDecide("reject") }) { Text("Reject") }
            }
        }
    }
}
