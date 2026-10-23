package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Agent chats. A chat is a task, so opening one goes to the task detail screen. */
@Composable
fun ChatsScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onOpen: (String) -> Unit) {
    val state = rememberLoad(companyId) { api.chats(companyId) }
    val scope = rememberCoroutineScope()
    var picking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LiveEvents(api, companyId) { if (it.type == "activity.logged") state.reload() }
    Box(Modifier.fillMaxSize()) {
        LoadedContent(state) { chats ->
            if (chats.isEmpty()) EmptyState("No chats yet. Start one with an agent.")
            else LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
                items(chats, key = { it.id }) { c ->
                    Row(Modifier.fillMaxWidth().clickable { onOpen(c.id) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(c.assigneeAgentId?.let { agentsById[it]?.name } ?: c.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(relativeTime(c.lastActivityAt ?: c.updatedAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (c.isUnreadForMe == true) Text("●", color = MaterialTheme.colorScheme.tertiary)
                    }
                    HorizontalDivider()
                }
            }
        }
        Box(Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
            ExtendedFloatingActionButton(onClick = { picking = true }, icon = { Icon(Icons.Default.Add, null) }, text = { Text("New chat") })
            DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                agentsById.values.filter { it.status != "terminated" }.sortedBy { it.name }.forEach { a ->
                    DropdownMenuItem(text = { Text(a.name) }, onClick = {
                        picking = false
                        scope.launch {
                            runCatching { api.openChat(companyId, a.urlKey ?: a.id) }
                                .onSuccess { onOpen(it.id) }
                                .onFailure { error = it.message }
                        }
                    })
                }
            }
        }
    }
}
