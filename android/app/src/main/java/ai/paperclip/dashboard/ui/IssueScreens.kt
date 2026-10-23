package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.ISSUE_PRIORITIES
import ai.paperclip.dashboard.data.ISSUE_STATUSES
import ai.paperclip.dashboard.data.Issue
import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun IssuesScreen(
    api: PaperclipApi,
    companyId: String,
    initialStatus: String?,
    agentsById: Map<String, Agent>,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
    filter: String? = null,
) {
    var status by rememberSaveable(initialStatus) { mutableStateOf(initialStatus) }
    var query by rememberSaveable { mutableStateOf("") }
    var debounced by remember { mutableStateOf(query) }
    androidx.compose.runtime.LaunchedEffect(query) {
        delay(350)
        debounced = query
    }
    val state = rememberLoad(companyId, status, debounced, filter) { api.issues(companyId, status, debounced, filter) }
    // Later pages, appended by "Load more"; reset whenever the first page reloads.
    var more by remember(state.data) { mutableStateOf(emptyList<Issue>()) }
    var hasMore by remember(state.data) { mutableStateOf(state.data?.size == PaperclipApi.ISSUE_PAGE) }
    var loadingMore by remember(state.data) { mutableStateOf(false) }
    var moreError by remember(state.data) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun loadMore(loaded: Int) {
        loadingMore = true
        scope.launch {
            runCatching { api.issues(companyId, status, debounced, filter, offset = loaded) }
                .onSuccess { page -> more = more + page; hasMore = page.size == PaperclipApi.ISSUE_PAGE; moreError = null }
                .onFailure { moreError = it.message }
            loadingMore = false
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search issues") },
                leadingIcon = { Icon(Icons.Default.Search, null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(selected = status == null, onClick = { status = null }, label = { Text("All") })
                ISSUE_STATUSES.forEach { s ->
                    FilterChip(selected = status == s, onClick = { status = s }, label = { Text(humanize(s)) })
                }
            }
            LoadedContent(state) { firstPage ->
                // Issues can shift between pages while paging; drop repeats so LazyColumn keys stay unique.
                val issues = (firstPage + more).distinctBy { it.id }
                if (issues.isEmpty()) {
                    // Keep it scrollable so pull-to-refresh still works on an empty list.
                    LazyColumn(Modifier.fillMaxSize()) { item { EmptyState("No issues") } }
                } else {
                    LazyColumn(contentPadding = PaddingValues(bottom = 88.dp)) {
                        items(issues, key = { it.id }) { issue ->
                            IssueRow(issue, agentsById[issue.assigneeAgentId]?.name) { onOpen(issue.id) }
                            HorizontalDivider()
                        }
                        if (hasMore) {
                            item(key = "load-more") {
                                Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                    moreError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                                    OutlinedButton(enabled = !loadingMore, onClick = { loadMore(firstPage.size + more.size) }) {
                                        Text(if (loadingMore) "Loading…" else "Load more")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        FloatingActionButton(onClick = onNew, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
            Icon(Icons.Default.Add, "New issue")
        }
    }
}

@Composable
private fun IssueRow(issue: Issue, assignee: String?, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            issue.identifier?.let {
                Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            StatusPill(issue.status)
            if (issue.priority == "critical" || issue.priority == "high") StatusPill(issue.priority)
        }
        Text(issue.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
            listOfNotNull(assignee, relativeTime(issue.updatedAt).ifBlank { null }).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
fun CommentCard(author: String, createdAt: String?, body: String, onDelete: (() -> Unit)? = null) {
    var confirm by remember { mutableStateOf(false) }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Delete comment?") },
        confirmButton = { TextButton(onClick = { confirm = false; onDelete?.invoke() }) { Text("Delete") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(author, style = MaterialTheme.typography.labelLarge)
                Text(relativeTime(createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                if (onDelete != null) TextButton(onClick = { confirm = true }) { Text("Delete") }
            }
            Markdown(body)
        }
    }
}

@Composable
internal fun ChoiceButton(label: String, value: String, options: List<String>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }) { Text("$label: ${humanize(value)}") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o ->
                DropdownMenuItem(text = { Text(humanize(o)) }, onClick = {
                    open = false
                    if (o != value) onPick(o)
                })
            }
        }
    }
}

@Composable
internal fun AssigneeButton(agentId: String?, agentsById: Map<String, Agent>, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }) {
            Text("Assignee: " + (agentId?.let { agentsById[it]?.name ?: "Agent" } ?: "Unassigned"))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Unassigned") }, onClick = { open = false; if (agentId != null) onPick(null) })
            agentsById.values.filter { it.status != "terminated" }.sortedBy { it.name }.forEach { a ->
                DropdownMenuItem(text = { Text(a.name) }, onClick = { open = false; if (a.id != agentId) onPick(a.id) })
            }
        }
    }
}

@Composable
fun NewIssueScreen(api: PaperclipApi, companyId: String, agentsById: Map<String, Agent>, onCreated: (String) -> Unit) {
    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var priority by rememberSaveable { mutableStateOf("medium") }
    var assignee by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedTextField(title, { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            description, { description = it },
            label = { Text("Description") },
            minLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ChoiceButton("Priority", priority, ISSUE_PRIORITIES) { priority = it }
        }
        AssigneeButton(assignee, agentsById) { assignee = it }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = title.isNotBlank() && !busy,
            onClick = {
                busy = true
                scope.launch {
                    runCatching { api.createIssue(companyId, title.trim(), description.trim(), priority, assignee) }
                        .onSuccess { onCreated(it.id) }
                        .onFailure { error = it.message }
                    busy = false
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Creating…" else "Create issue") }
    }
}
