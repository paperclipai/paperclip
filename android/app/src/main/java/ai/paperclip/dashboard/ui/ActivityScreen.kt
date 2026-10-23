package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.ActivityEvent
import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Composable
fun ActivityScreen(
    api: PaperclipApi,
    companyId: String,
    agentsById: Map<String, Agent>,
    onOpenIssue: (String) -> Unit,
    onOpenAgent: (String) -> Unit,
    onOpenApproval: (String) -> Unit,
) {
    val state = rememberLoad(companyId) { api.activity(companyId) }
    LoadedContent(state) { events ->
        if (events.isEmpty()) {
            LazyColumn(Modifier.fillMaxSize()) { item { EmptyState("No activity yet") } }
        } else {
            LazyColumn {
                items(events, key = { it.id }) { e ->
                    val open: (() -> Unit)? = when (e.entityType) {
                        "issue" -> ({ onOpenIssue(e.entityId) })
                        "agent" -> ({ onOpenAgent(e.entityId) })
                        "approval" -> ({ onOpenApproval(e.entityId) })
                        else -> null
                    }
                    Column(
                        Modifier.fillMaxWidth()
                            .then(if (open != null) Modifier.clickable(onClick = open) else Modifier)
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(describe(e, agentsById), style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "${humanize(e.entityType)} · ${relativeTime(e.createdAt)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

private fun describe(e: ActivityEvent, agentsById: Map<String, Agent>): String {
    val actor = when (e.actorType) {
        "agent" -> agentsById[e.actorId]?.name ?: "An agent"
        "user" -> "Board"
        "plugin" -> "Plugin"
        else -> "System"
    }
    val subject = e.details?.let { d ->
        listOf("identifier", "title", "name").firstNotNullOfOrNull { (d[it] as? JsonPrimitive)?.contentOrNull }
    }
    // Actions look like "issue.updated"; show the verb part.
    val verb = humanize(e.action.substringAfterLast('.')).lowercase()
    return listOfNotNull(actor, verb, subject).joinToString(" ")
}
