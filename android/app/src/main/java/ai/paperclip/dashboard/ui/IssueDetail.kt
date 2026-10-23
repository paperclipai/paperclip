@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.ISSUE_PRIORITIES
import ai.paperclip.dashboard.data.ISSUE_STATUSES
import ai.paperclip.dashboard.data.Issue
import ai.paperclip.dashboard.data.IssueAttachment
import ai.paperclip.dashboard.data.IssueInteraction
import ai.paperclip.dashboard.data.IssueLabel
import ai.paperclip.dashboard.data.PaperclipApi
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.io.File

private val DETAIL_TABS = listOf("Comments", "Sub-issues", "Documents", "Files", "Runs", "Activity")

/**
 * Task detail with the web board's controls: status, priority, assignee, labels, blocked-by,
 * markdown description, agent questions, comments (reopen / interrupt / delete), sub-issues,
 * documents, attachments, runs and activity.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun IssueDetailScreen(
    api: PaperclipApi,
    issueId: String,
    agentsById: Map<String, Agent>,
    onOpenIssue: (String) -> Unit = {},
    onOpenRun: (String) -> Unit = {},
    onOpenDocument: (String, String) -> Unit = { _, _ -> },
    onDeleted: () -> Unit = {},
) {
    val issueState = rememberLoad(issueId) { api.issue(issueId) }
    val commentsState = rememberLoad(issueId) { api.issueComments(issueId) }
    val interactionsState = rememberLoad(issueId) { runCatching { api.interactions(issueId) }.getOrDefault(emptyList()) }
    val scope = rememberCoroutineScope()
    var actionError by remember { mutableStateOf<String?>(null) }
    var draft by rememberSaveable { mutableStateOf("") }
    var reopen by rememberSaveable { mutableStateOf(false) }
    var interrupt by rememberSaveable { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var updating by remember { mutableStateOf(false) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var confirmDelete by remember { mutableStateOf(false) }

    // Mark read on open, as the web board does.
    androidx.compose.runtime.LaunchedEffect(issueId) { runCatching { api.markIssueRead(issueId) } }
    issueState.data?.companyId?.takeIf { it.isNotBlank() }?.let { cid ->
        LiveEvents(api, cid) { ev ->
            val touches = ev.payload.s("issueId") == issueId || ev.payload.s("entityId") == issueId
            if (touches) { issueState.reload(); commentsState.reload(); interactionsState.reload() }
        }
    }

    // Ignores taps while a change is saving, so a double tap cannot send two PATCHes.
    fun patch(fields: JsonObject) {
        if (updating) return
        updating = true
        scope.launch {
            actionError = runCatching { api.updateIssue(issueId, fields) }.exceptionOrNull()?.message
            updating = false
            issueState.reload()
        }
    }
    fun update(field: String, value: String?) = patch(buildJsonObject { put(field, value) })
    fun act(reload: () -> Unit = { issueState.reload() }, block: suspend () -> Unit) {
        scope.launch {
            actionError = runCatching { block() }.exceptionOrNull()?.message
            reload()
        }
    }

    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("Delete this task?") },
        text = { Text("This permanently removes the task and its comments.") },
        confirmButton = {
            TextButton(onClick = {
                confirmDelete = false
                scope.launch {
                    val r = runCatching { api.deleteIssue(issueId) }
                    if (r.isSuccess) onDeleted() else actionError = r.exceptionOrNull()?.message
                }
            }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )

    Column(Modifier.fillMaxSize().imePadding()) {
        LoadedContent(issueState, Modifier.weight(1f)) { issue ->
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item(key = "header") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            issue.identifier?.let {
                                Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                            } ?: Box(Modifier.weight(1f))
                            IssueMenu(
                                issue, agentsById,
                                onWake = { agentId -> act { api.wakeAgentForIssue(agentId, issue.companyId, issueId) } },
                                onRename = { update("title", it) },
                                onDelete = { confirmDelete = true },
                            )
                        }
                        Text(issue.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            ChoiceButton("Status", issue.status, ISSUE_STATUSES) { update("status", it) }
                            ChoiceButton("Priority", issue.priority, ISSUE_PRIORITIES) { update("priority", it) }
                            AssigneeButton(issue.assigneeAgentId, agentsById) { update("assigneeAgentId", it) }
                        }
                        issue.activeRun?.let { run ->
                            OutlinedCard(Modifier.fillMaxWidth().clickable { onOpenRun(run.id) }) {
                                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        "${agentsById[run.agentId]?.name ?: "Agent"} is working on this",
                                        style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f),
                                    )
                                    StatusPill(run.status)
                                }
                            }
                        }
                        LabelsRow(api, issue) { ids -> patch(buildJsonObject { putJsonArray("labelIds") { ids.forEach { add(it) } } }) }
                        BlockedByRow(api, issue, onOpenIssue) { ids -> patch(buildJsonObject { putJsonArray("blockedByIssueIds") { ids.forEach { add(it) } } }) }
                        actionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                }
                item(key = "description") {
                    var editing by rememberSaveable(issueId) { mutableStateOf(false) }
                    var text by rememberSaveable(issueId) { mutableStateOf(issue.description.orEmpty()) }
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (editing) {
                                OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().heightIn(min = 160.dp), label = { Text("Description (markdown)") })
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(enabled = !updating, onClick = { update("description", text); editing = false }) { Text("Save") }
                                    TextButton(onClick = { text = issue.description.orEmpty(); editing = false }) { Text("Cancel") }
                                }
                            } else {
                                if (issue.description.isNullOrBlank()) Text("No description", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                else Markdown(issue.description)
                                TextButton(onClick = { text = issue.description.orEmpty(); editing = true }) { Text("Edit description") }
                            }
                        }
                    }
                }
                interactionsState.data.orEmpty().filter { it.status == "pending" }.forEach { inter ->
                    item(key = "interaction:${inter.id}") {
                        InteractionCard(inter) { action, body ->
                            act({ interactionsState.reload(); issueState.reload() }) { api.resolveInteraction(issueId, inter.id, action, body) }
                        }
                    }
                }
                item(key = "tabs") {
                    SecondaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
                        DETAIL_TABS.forEachIndexed { i, t -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(t) }) }
                    }
                }
                when (tab) {
                    0 -> {
                        val comments = commentsState.data?.filter { it.deletedAt == null }
                        when {
                            comments == null && commentsState.error != null -> item { Text(commentsState.error, color = MaterialTheme.colorScheme.error) }
                            comments == null -> item { Text("Loading…") }
                            comments.isEmpty() -> item { Text("No comments yet", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            else -> items(comments, key = { it.id }) { c ->
                                val author = c.authorAgentId?.let { agentsById[it]?.name ?: "Agent" }
                                    ?: if (c.authorUserId != null) "Board" else humanize(c.authorType ?: "system")
                                CommentCard(author, c.createdAt, c.body, onDelete = if (c.authorUserId != null) {
                                    { act({ commentsState.reload() }) { api.deleteIssueComment(issueId, c.id) } }
                                } else null)
                            }
                        }
                    }
                    1 -> item(key = "subs") { SubIssues(api, issue, agentsById, onOpenIssue) }
                    2 -> item(key = "docs") { Documents(api, issueId) { key -> onOpenDocument(issueId, key) } }
                    3 -> item(key = "files") { Attachments(api, issue) }
                    4 -> item(key = "runs") { IssueRuns(api, issueId, agentsById, onOpenRun) }
                    5 -> item(key = "activity") { IssueActivity(api, issueId) }
                }
            }
        }
        if (tab == 0) {
            HorizontalDivider()
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = reopen, onClick = { reopen = !reopen }, label = { Text("Reopen") })
                    if (issueState.data?.activeRun != null) {
                        FilterChip(selected = interrupt, onClick = { interrupt = !interrupt }, label = { Text("Interrupt agent") })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        placeholder = { Text("Add a comment (markdown, @mentions)") },
                        maxLines = 6,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(
                        enabled = draft.isNotBlank() && !sending,
                        onClick = {
                            sending = true
                            scope.launch {
                                val result = runCatching {
                                    api.addIssueComment(issueId, draft.trim(), reopen = reopen, interrupt = interrupt && issueState.data?.activeRun != null)
                                }
                                actionError = result.exceptionOrNull()?.message
                                if (result.isSuccess) { draft = ""; reopen = false; interrupt = false }
                                sending = false
                                commentsState.reload()
                                issueState.reload()
                            }
                        },
                    ) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
                }
            }
        }
    }
}

@Composable
private fun IssueMenu(
    issue: Issue,
    agentsById: Map<String, Agent>,
    onWake: (String) -> Unit,
    onRename: (String) -> Unit,
    onDelete: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var title by remember(issue.title) { mutableStateOf(issue.title) }
    if (renaming) AlertDialog(
        onDismissRequest = { renaming = false },
        title = { Text("Rename task") },
        text = { OutlinedTextField(title, { title = it }, singleLine = true) },
        confirmButton = { TextButton(enabled = title.isNotBlank(), onClick = { renaming = false; onRename(title.trim()) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
    )
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Default.MoreVert, "Task actions") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            issue.assigneeAgentId?.let { id ->
                DropdownMenuItem(
                    text = { Text("Wake ${agentsById[id]?.name ?: "agent"} on this task") },
                    onClick = { open = false; onWake(id) },
                )
            }
            DropdownMenuItem(text = { Text("Rename") }, onClick = { open = false; renaming = true })
            DropdownMenuItem(text = { Text("Delete task", color = MaterialTheme.colorScheme.error) }, onClick = { open = false; onDelete() })
        }
    }
}

fun parseHexColor(hex: String): Color? = runCatching {
    Color(android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#$hex"))
}.getOrNull()

@Composable
fun LabelChip(label: IssueLabel) {
    val c = parseHexColor(label.color) ?: MaterialTheme.colorScheme.outline
    Text(
        label.name,
        style = MaterialTheme.typography.labelSmall,
        color = c,
        modifier = Modifier.background(c.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LabelsRow(api: PaperclipApi, issue: Issue, onSet: (List<String>) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val all = rememberLoad(issue.companyId) { api.labels(issue.companyId) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        issue.labels.forEach { LabelChip(it) }
        Box {
            TextButton(onClick = { open = true }) { Text(if (issue.labels.isEmpty()) "Add labels" else "Edit labels") }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                val list = all.data.orEmpty()
                if (list.isEmpty()) DropdownMenuItem(text = { Text("No labels in this company") }, onClick = { open = false })
                list.forEach { l ->
                    val on = l.id in issue.labelIds || issue.labels.any { it.id == l.id }
                    DropdownMenuItem(
                        text = { Text(l.name) },
                        leadingIcon = { Checkbox(checked = on, onCheckedChange = null) },
                        onClick = {
                            val current = (issue.labelIds + issue.labels.map { it.id }).distinct()
                            onSet(if (on) current - l.id else current + l.id)
                            open = false
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BlockedByRow(api: PaperclipApi, issue: Issue, onOpenIssue: (String) -> Unit, onSet: (List<String>) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    if (picking) IssuePickerDialog(api, issue.companyId, exclude = setOf(issue.id) + issue.blockedBy.map { it.id }, onDismiss = { picking = false }) { picked ->
        picking = false
        onSet(issue.blockedBy.map { it.id } + picked.id)
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (issue.blockedBy.isNotEmpty()) Text("Blocked by", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        issue.blockedBy.forEach { b ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${b.identifier ?: ""} ${b.title}".trim(),
                    modifier = Modifier.weight(1f).clickable { onOpenIssue(b.id) }.padding(vertical = 4.dp),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                StatusPill(b.status)
                TextButton(onClick = { onSet(issue.blockedBy.map { it.id } - b.id) }) { Text("Remove") }
            }
        }
        if (issue.blocks.isNotEmpty()) Text("Blocks", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        issue.blocks.forEach { b ->
            Text(
                "${b.identifier ?: ""} ${b.title}".trim(),
                modifier = Modifier.fillMaxWidth().clickable { onOpenIssue(b.id) }.padding(vertical = 4.dp),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        TextButton(onClick = { picking = true }) { Text("Add blocker") }
    }
}

@Composable
fun IssuePickerDialog(api: PaperclipApi, companyId: String, exclude: Set<String>, onDismiss: () -> Unit, onPick: (Issue) -> Unit) {
    var q by remember { mutableStateOf("") }
    val results = rememberLoad(companyId, q) {
        if (q.isNotBlank()) kotlinx.coroutines.delay(300)
        api.issues(companyId, null, q.ifBlank { null })
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Pick a task") },
        text = {
            Column {
                OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("Search") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(results.data.orEmpty().filter { it.id !in exclude }, key = { it.id }) { i ->
                        Text(
                            "${i.identifier ?: ""} ${i.title}".trim(),
                            modifier = Modifier.fillMaxWidth().clickable { onPick(i) }.padding(vertical = 10.dp),
                            maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun SubIssues(api: PaperclipApi, issue: Issue, agentsById: Map<String, Agent>, onOpenIssue: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val state = rememberLoad(issue.id) { api.subIssues(issue.companyId, issue.id) }
    var title by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        state.data.orEmpty().forEach { s ->
            Row(Modifier.fillMaxWidth().clickable { onOpenIssue(s.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(s.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOfNotNull(s.identifier, s.assigneeAgentId?.let { agentsById[it]?.name }).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusPill(s.status)
            }
        }
        if (state.data?.isEmpty() == true) Text("No sub-issues", color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(title, { title = it }, singleLine = true, placeholder = { Text("New sub-issue") }, modifier = Modifier.weight(1f))
            TextButton(enabled = title.isNotBlank() && !busy, onClick = {
                busy = true
                scope.launch {
                    error = runCatching {
                        api.createIssue(issue.companyId, title.trim(), "", "medium", null, parentId = issue.id, projectId = issue.projectId)
                    }.exceptionOrNull()?.message
                    if (error == null) title = ""
                    busy = false
                    state.reload()
                }
            }) { Text("Add") }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun Documents(api: PaperclipApi, issueId: String, onOpen: (String) -> Unit) {
    val state = rememberLoad(issueId) { api.issueDocuments(issueId) }
    var newKey by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        state.data.orEmpty().forEach { d ->
            Row(Modifier.fillMaxWidth().clickable { onOpen(d.key) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.title ?: d.key, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "${d.key} · rev ${d.latestRevisionNumber} · ${relativeTime(d.updatedAt)}" + if (d.lockedAt != null) " · locked" else "",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        if (state.data?.isEmpty() == true) Text("No documents", color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(newKey, { newKey = it.lowercase().replace(Regex("[^a-z0-9_-]"), "-") }, singleLine = true, placeholder = { Text("New document key, e.g. plan") }, modifier = Modifier.weight(1f))
            TextButton(enabled = newKey.isNotBlank(), onClick = { onOpen(newKey); newKey = "" }) { Text("Create") }
        }
    }
}

/** Full-screen document viewer / editor. Saves with baseRevisionId so a stale copy cannot overwrite a newer one. */
@Composable
fun IssueDocumentScreen(api: PaperclipApi, issueId: String, key: String) {
    val scope = rememberCoroutineScope()
    val state = rememberLoad(issueId, key) {
        runCatching { api.issueDocument(issueId, key) }.getOrElse { e ->
            if ((e as? ai.paperclip.dashboard.data.ApiException)?.code == 404) ai.paperclip.dashboard.data.IssueDocument(key = key) else throw e
        }
    }
    var editing by rememberSaveable { mutableStateOf(false) }
    var body by rememberSaveable { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LoadedContent(state) { doc ->
        Column(Modifier.fillMaxSize().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(doc.title ?: key, style = MaterialTheme.typography.titleLarge)
                    Text("${doc.key} · rev ${doc.latestRevisionNumber}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!editing && doc.lockedAt == null) TextButton(onClick = { body = doc.body; editing = true }) { Text("Edit") }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (editing) {
                OutlinedTextField(body.orEmpty(), { body = it }, Modifier.fillMaxWidth().weight(1f))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !saving, onClick = {
                        saving = true
                        scope.launch {
                            error = runCatching { api.saveIssueDocument(issueId, key, doc.title, body.orEmpty(), doc.latestRevisionId) }
                                .exceptionOrNull()?.let { if ((it as? ai.paperclip.dashboard.data.ApiException)?.code == 409) "Someone changed this document. Reload and try again." else it.message }
                            saving = false
                            if (error == null) { editing = false; state.reload() }
                        }
                    }) { Text("Save") }
                    TextButton(onClick = { editing = false; error = null }) { Text("Cancel") }
                }
            } else {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    if (doc.body.isBlank()) Text("Empty document", color = MaterialTheme.colorScheme.onSurfaceVariant) else Markdown(doc.body)
                }
            }
        }
    }
}

@Composable
private fun Attachments(api: PaperclipApi, issue: Issue) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state = rememberLoad(issue.id) { api.issueAttachments(issue.id) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri ?: return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            error = runCatching {
                val (name, bytes) = withContext(Dispatchers.IO) {
                    val resolver = context.contentResolver
                    val n = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) c.getString(0) else null
                    } ?: "upload"
                    n to (resolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0))
                }
                api.uploadAttachment(issue.companyId, issue.id, name, context.contentResolver.getType(uri) ?: "application/octet-stream", bytes)
            }.exceptionOrNull()?.message
            busy = false
            state.reload()
        }
    }
    fun open(a: IssueAttachment) {
        busy = true
        scope.launch {
            error = runCatching {
                val file = withContext(Dispatchers.IO) {
                    val dir = File(context.cacheDir, "attachments").apply { mkdirs() }
                    File(dir, a.originalFilename?.replace("/", "_") ?: a.id).apply { writeBytes(api.download(a.contentPath.ifBlank { "/api/attachments/${a.id}/content" })) }
                }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                context.startActivity(
                    Intent.createChooser(
                        Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.contentType.ifBlank { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                        a.originalFilename,
                    )
                )
            }.exceptionOrNull()?.message
            busy = false
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        state.data.orEmpty().forEach { a ->
            Row(Modifier.fillMaxWidth().clickable(enabled = !busy) { open(a) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(a.originalFilename ?: a.id, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${a.contentType} · ${formatBytes(a.byteSize)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(enabled = !busy, onClick = {
                    scope.launch {
                        error = runCatching { api.deleteAttachment(a.id) }.exceptionOrNull()?.message
                        state.reload()
                    }
                }) { Text("Delete") }
            }
        }
        if (state.data?.isEmpty() == true) Text("No files", color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        OutlinedButton(enabled = !busy, onClick = { picker.launch(arrayOf("*/*")) }) {
            Icon(Icons.Default.AttachFile, null)
            Text(if (busy) "Working…" else "Attach file")
        }
    }
}

fun formatBytes(n: Long): String = when {
    n >= 1 shl 20 -> "%.1f MB".format(n / 1048576.0)
    n >= 1 shl 10 -> "%.0f KB".format(n / 1024.0)
    else -> "$n B"
}

@Composable
private fun IssueRuns(api: PaperclipApi, issueId: String, agentsById: Map<String, Agent>, onOpenRun: (String) -> Unit) {
    val state = rememberLoad(issueId) { api.issueRuns(issueId) }
    Column {
        state.data.orEmpty().forEach { r ->
            Row(Modifier.fillMaxWidth().clickable { onOpenRun(r.runId) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(agentsById[r.agentId]?.name ?: "Agent")
                    Text(
                        listOfNotNull(r.invocationSource?.let(::humanize), relativeTime(r.startedAt ?: r.createdAt), r.errorCode).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusPill(r.status)
            }
        }
        if (state.data?.isEmpty() == true) Text("No runs yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun IssueActivity(api: PaperclipApi, issueId: String) {
    val state = rememberLoad(issueId) { api.issueActivity(issueId) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        state.data.orEmpty().forEach { e ->
            Column {
                Text(humanize(e.action), style = MaterialTheme.typography.bodyMedium)
                Text(
                    listOfNotNull(humanize(e.actorType), relativeTime(e.createdAt)).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (state.data?.isEmpty() == true) Text("No activity", color = MaterialTheme.colorScheme.onSurfaceVariant)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/**
 * Agent questions and confirmations that wait on a human: ask_user_questions, request_confirmation,
 * request_checkbox_confirmation and request_item_verdicts. Other kinds show their summary only.
 */
@Composable
private fun InteractionCard(inter: IssueInteraction, onResolve: (String, JsonObject) -> Unit) {
    var busy by remember(inter.id) { mutableStateOf(false) }
    fun go(action: String, body: JsonObject = JsonObject(emptyMap())) { busy = true; onResolve(action, body) }
    val p = inter.payload
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Waiting for you · ${humanize(inter.kind)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
            (inter.title ?: p.s("prompt") ?: p.s("title"))?.let { Text(it, style = MaterialTheme.typography.titleSmall) }
            (inter.summary ?: p.s("detailsMarkdown"))?.let { Markdown(it) }
            when (inter.kind) {
                "ask_user_questions" -> {
                    val questions = (p["questions"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                    val picks = remember(inter.id) { mutableStateOf(mapOf<String, Set<String>>()) }
                    val other = remember(inter.id) { mutableStateOf(mapOf<String, String>()) }
                    questions.forEach { q ->
                        val qid = q.s("id") ?: return@forEach
                        val multi = q.s("selectionMode") == "multi"
                        Text(q.s("prompt").orEmpty(), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        q.s("helpText")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        (q["options"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.forEach { o ->
                            val oid = o.s("id") ?: return@forEach
                            val sel = oid in picks.value[qid].orEmpty()
                            Row(
                                Modifier.fillMaxWidth().clickable {
                                    val cur = picks.value[qid].orEmpty()
                                    picks.value = picks.value + (qid to if (multi) (if (sel) cur - oid else cur + oid) else setOf(oid))
                                },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (multi) Checkbox(sel, null) else RadioButton(sel, null)
                                Column {
                                    Text(o.s("label").orEmpty())
                                    o.s("description")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                }
                            }
                        }
                        if (q["allowOther"]?.jsonPrimitive?.booleanOrNull == true) {
                            OutlinedTextField(other.value[qid].orEmpty(), { other.value = other.value + (qid to it) }, placeholder = { Text("Other") }, modifier = Modifier.fillMaxWidth())
                        }
                    }
                    Button(enabled = !busy, onClick = {
                        go("respond", buildJsonObject {
                            putJsonArray("answers") {
                                questions.mapNotNull { it.s("id") }.forEach { qid ->
                                    addJsonObject {
                                        put("questionId", qid)
                                        putJsonArray("optionIds") { picks.value[qid].orEmpty().forEach { add(it) } }
                                        other.value[qid]?.takeIf { it.isNotBlank() }?.let { put("otherText", it) }
                                    }
                                }
                            }
                        })
                    }) { Text(p.s("submitLabel") ?: "Submit answers") }
                }
                "request_item_verdicts" -> {
                    val itemsList = (p["items"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                    val verdicts = remember(inter.id) { mutableStateOf(mapOf<String, String>()) }
                    itemsList.forEach { it2 ->
                        val id = it2.s("id") ?: return@forEach
                        Text(it2.s("label") ?: it2.s("title") ?: id, style = MaterialTheme.typography.bodyMedium)
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf("approve", "reject").forEach { v ->
                                FilterChip(selected = verdicts.value[id] == v, onClick = { verdicts.value = verdicts.value + (id to v) }, label = { Text(humanize(v)) })
                            }
                        }
                    }
                    Button(enabled = !busy && verdicts.value.size == itemsList.size, onClick = {
                        go("verdicts", buildJsonObject {
                            putJsonArray("verdicts") { verdicts.value.forEach { (id, v) -> addJsonObject { put("id", id); put("verdict", v) } } }
                        })
                    }) { Text("Submit verdicts") }
                }
                "request_confirmation", "request_checkbox_confirmation" -> {
                    val options = (p["options"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                    val selected = remember(inter.id) { mutableStateOf(setOf<String>()) }
                    var reason by remember(inter.id) { mutableStateOf("") }
                    options.forEach { o ->
                        val oid = o.s("id") ?: return@forEach
                        Row(Modifier.fillMaxWidth().clickable {
                            selected.value = if (oid in selected.value) selected.value - oid else selected.value + oid
                        }, verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(oid in selected.value, null)
                            Text(o.s("label").orEmpty())
                        }
                    }
                    val needsReason = p["rejectRequiresReason"]?.jsonPrimitive?.booleanOrNull == true
                    OutlinedTextField(reason, { reason = it }, placeholder = { Text(if (needsReason) "Reason (required to reject)" else "Reason (optional)") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(enabled = !busy, onClick = {
                            go("accept", if (options.isEmpty()) JsonObject(emptyMap()) else buildJsonObject {
                                putJsonArray("selectedOptionIds") { selected.value.forEach { add(it) } }
                            })
                        }) { Text(p.s("acceptLabel") ?: "Accept") }
                        OutlinedButton(enabled = !busy && (!needsReason || reason.isNotBlank()), onClick = {
                            go("reject", buildJsonObject { if (reason.isNotBlank()) put("reason", reason) else put("reason", JsonNull) })
                        }) { Text(p.s("rejectLabel") ?: "Reject") }
                    }
                }
                else -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(enabled = !busy, onClick = { go("skip") }) { Text("Skip") }
                }
            }
        }
    }
}

private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()
