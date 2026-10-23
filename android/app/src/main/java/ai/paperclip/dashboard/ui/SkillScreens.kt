@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ai.paperclip.dashboard.ui

import ai.paperclip.dashboard.data.PaperclipApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** Runs one mutation at a time and keeps its error for display. */
class ActionRunner(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    var notice by mutableStateOf<String?>(null)

    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        notice = null
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Something went wrong"
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberActionRunner(): ActionRunner {
    val scope = rememberCoroutineScope()
    return remember { ActionRunner(scope) }
}

@Composable
fun ActionMessages(runner: ActionRunner) {
    runner.error?.let { ErrorBanner(it) }
    runner.notice?.let {
        Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
    }
}

internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
internal fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
internal fun JsonObject.arr(key: String): List<JsonObject> = (this[key] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
internal fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()

private val SKILL_TABS = listOf("Library", "Catalog", "GitHub sources")

/** Skills hub: the company library, the built-in catalog and tracked GitHub repositories. */
@Composable
fun SkillsScreen(api: PaperclipApi, companyId: String, onOpenSkill: (String) -> Unit, onOpenCatalog: (String) -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var importing by remember { mutableStateOf(false) }
    var version by remember { mutableIntStateOf(0) }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            SecondaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
                SKILL_TABS.forEachIndexed { i, t -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(t) }) }
            }
            when (tab) {
                0 -> SkillLibrary(api, companyId, version, onOpenSkill)
                1 -> SkillCatalog(api, onOpenCatalog)
                else -> SkillSources(api, companyId, version)
            }
        }
        ExtendedFloatingActionButton(
            onClick = { importing = true },
            icon = { Icon(Icons.Default.Add, null) },
            text = { Text("Add skill") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
    if (importing) ImportSkillDialog(api, companyId, onDismiss = { importing = false }) { imported ->
        importing = false
        version++
        tab = 0
        imported?.let(onOpenSkill)
    }
}

/** Mirrors the web "Add skill" import: GitHub, skills.sh, HTTPS URL or an `npx skills add` command. */
@Composable
private fun ImportSkillDialog(api: PaperclipApi, companyId: String, onDismiss: () -> Unit, onDone: (String?) -> Unit) {
    var source by rememberSaveable { mutableStateOf("") }
    val runner = rememberActionRunner()
    AlertDialog(
        onDismissRequest = { if (!runner.busy) onDismiss() },
        title = { Text("Add skill") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Import from a GitHub repo (owner/repo or a github.com URL), skills.sh, an HTTPS URL, or paste an `npx skills add …` command.",
                    style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(source, { source = it }, label = { Text("Source") }, singleLine = true,
                    placeholder = { Text("owner/repo") }, modifier = Modifier.fillMaxWidth())
                runner.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(enabled = source.isNotBlank() && !runner.busy, onClick = {
                runner.run {
                    val res = api.importSkill(companyId, source.trim()) as? JsonObject
                    val first = res?.arr("imported")?.firstOrNull()?.str("id")
                    onDone(first)
                }
            }) { Text(if (runner.busy) "Importing…" else "Import") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !runner.busy) { Text("Cancel") } },
    )
}

@Composable
private fun SkillLibrary(api: PaperclipApi, companyId: String, version: Int, onOpen: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val state = rememberLoad(companyId, query, version) { api.skills(companyId, query).asItems() }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, placeholder = { Text("Search skills") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
        LoadedContent(state) { items ->
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
                if (items.isEmpty()) item { EmptyState("No skills installed yet") }
                items(items, key = { it.str("id") ?: it.titleText() }) { s ->
                    val agents = s.int("attachedAgentCount") ?: 0
                    ListRow(
                        s.titleText(),
                        listOfNotNull(
                            s.str("sourceLabel", "sourceType")?.let(::humanize),
                            if (agents > 0) "$agents agent${if (agents == 1) "" else "s"}" else null,
                            s.str("description", "tagline")?.lineSequence()?.firstOrNull(),
                        ).joinToString(" · "),
                        s.str("compatibility")?.takeIf { it != "compatible" },
                    ) { s.str("id")?.let(onOpen) }
                }
            }
        }
    }
}

@Composable
private fun SkillCatalog(api: PaperclipApi, onOpen: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf<String?>(null) }
    val state = rememberLoad(query, kind) { api.skillCatalog(query, kind).asItems() }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, placeholder = { Text("Search the catalog") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
        StatusChips(listOf(null, "bundled", "optional"), kind) { kind = it }
        LoadedContent(state) { items ->
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
                if (items.isEmpty()) item { EmptyState("No catalog skills match") }
                items(items, key = { it.str("id") ?: it.titleText() }) { s ->
                    ListRow(
                        s.titleText(),
                        listOfNotNull(s.str("category")?.let(::humanize), s.str("trustLevel")?.let(::humanize),
                            s.str("description")?.lineSequence()?.firstOrNull()).joinToString(" · "),
                        s.str("kind"),
                    ) { s.str("id")?.let(onOpen) }
                }
            }
        }
    }
}

@Composable
private fun SkillSources(api: PaperclipApi, companyId: String, version: Int) {
    var refresh by remember { mutableIntStateOf(0) }
    val runner = rememberActionRunner()
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    val state = rememberLoad(companyId, version, refresh) { api.skillSources(companyId).asItems() }
    Column(Modifier.fillMaxSize()) {
        ActionMessages(runner)
        LoadedContent(state) { sources ->
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 88.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (sources.isEmpty()) item {
                    EmptyState("No GitHub sources. Add a skill from a GitHub repo to start tracking it.")
                }
                items(sources, key = { it.str("id") ?: it.titleText() }) { src ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(src.str("fullName", "repositoryUrl") ?: "Repository",
                                    style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                src.str("syncState")?.let { StatusPill(it) }
                            }
                            Text(listOfNotNull(src.str("trackingRef")?.let { "Tracking $it" },
                                "${src.arr("entries").size} skills",
                                src.str("lastSuccessAt")?.let { "synced ${relativeTime(it)}" }).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            src.str("lastError")?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(enabled = !runner.busy, onClick = {
                                    runner.run {
                                        api.refreshSkillSource(companyId, src.str("id")!!)
                                        runner.notice = "Refreshed ${src.str("fullName") ?: "source"}"
                                        refresh++
                                    }
                                }) { Text("Refresh") }
                                TextButton(enabled = !runner.busy, onClick = { deleting = src }) { Text("Remove") }
                            }
                        }
                    }
                }
            }
        }
    }
    deleting?.let { src ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Remove ${src.str("fullName") ?: "source"}?") },
            text = { Text("Keep copies of its skills in the library, or delete them too?") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    runner.run { api.deleteSkillSource(companyId, src.str("id")!!, src.int("revision") ?: 0, keepCopies = true); refresh++ }
                }) { Text("Keep copies") }
            },
            dismissButton = {
                TextButton(onClick = {
                    deleting = null
                    runner.run { api.deleteSkillSource(companyId, src.str("id")!!, src.int("revision") ?: 0, keepCopies = false); refresh++ }
                }) { Text("Delete skills", color = MaterialTheme.colorScheme.error) }
            },
        )
    }
}

/** Installed skill: source, update status, agents using it, SKILL.md, update and uninstall. */
@Composable
fun SkillDetailScreen(api: PaperclipApi, companyId: String, skillId: String, onOpenAgent: (String) -> Unit, onDeleted: () -> Unit) {
    var version by remember { mutableIntStateOf(0) }
    val runner = rememberActionRunner()
    var confirmDelete by remember { mutableStateOf(false) }
    val state = rememberLoad(skillId, version) {
        val skill = api.skill(companyId, skillId) as JsonObject
        val update = runCatching { api.skillUpdateStatus(companyId, skillId) as? JsonObject }.getOrNull()
        skill to update
    }
    LoadedContent(state) { (s, update) ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(s.titleText(), style = MaterialTheme.typography.headlineSmall)
                s.str("description", "tagline")?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
            item {
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Detail("Source", listOfNotNull(s.str("sourceType")?.let(::humanize), s.str("sourceLocator")).joinToString(" · "))
                        s.str("sourceRef")?.let { Detail("Ref", it) }
                        s.str("trustLevel")?.let { Detail("Trust", humanize(it)) }
                        s.str("compatibility")?.let { Detail("Compatibility", humanize(it)) }
                        Detail("Key", s.str("key") ?: "—")
                        s.str("updatedAt")?.let { Detail("Updated", relativeTime(it)) }
                    }
                }
            }
            if (update?.bool("supported") == true) item {
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        val hasUpdate = update.bool("hasUpdate") == true
                        Text(if (hasUpdate) "Update available" else "Up to date", fontWeight = FontWeight.SemiBold)
                        update.str("latestRef")?.let { Text("Latest: $it", style = MaterialTheme.typography.bodySmall) }
                        update.str("updateHoldReason")?.let {
                            Text("On hold: ${humanize(it)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                        }
                        if (hasUpdate) Button(enabled = !runner.busy, onClick = {
                            runner.run { api.installSkillUpdate(companyId, skillId); runner.notice = "Updated"; version++ }
                        }) { Text("Install update") }
                    }
                }
            }
            item {
                OutlinedButton(enabled = !runner.busy, onClick = { confirmDelete = true }) {
                    Text("Uninstall", color = MaterialTheme.colorScheme.error)
                }
            }
            item { ActionMessages(runner) }
            val users = s.arr("usedByAgents")
            item { Text("Used by ${users.size} agent${if (users.size == 1) "" else "s"}", style = MaterialTheme.typography.titleSmall) }
            items(users, key = { "agent:" + (it.str("id") ?: it.titleText()) }) { a ->
                ListRow(a.titleText(), listOfNotNull(a.str("adapterType"), a.str("actualState")?.let(::humanize)).joinToString(" · ")) {
                    a.str("id")?.let(onOpenAgent)
                }
            }
            s.str("markdown")?.let { md ->
                item { HorizontalDivider() }
                item { Markdown(md) }
            }
        }
    }
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("Uninstall skill?") },
        text = { Text("It is removed from the company library and from every agent that uses it.") },
        confirmButton = {
            TextButton(onClick = {
                confirmDelete = false
                runner.run { api.deleteSkill(companyId, skillId); onDeleted() }
            }) { Text("Uninstall", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
    )
}

/** Catalog skill preview with install. */
@Composable
fun CatalogSkillScreen(api: PaperclipApi, companyId: String, catalogId: String, onInstalled: (String?) -> Unit) {
    val runner = rememberActionRunner()
    val state = rememberLoad(catalogId) {
        val skill = api.getJson("/skills/catalog/${java.net.URLEncoder.encode(catalogId, "UTF-8")}") as JsonObject
        val md = runCatching { (api.catalogSkillFile(catalogId) as? JsonObject)?.str("content") }.getOrNull()
        skill to md
    }
    LoadedContent(state) { (s, md) ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(s.titleText(), style = MaterialTheme.typography.headlineSmall)
                s.str("description")?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
            item {
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        s.str("category")?.let { Detail("Category", humanize(it)) }
                        s.str("kind")?.let { Detail("Kind", humanize(it)) }
                        s.str("trustLevel")?.let { Detail("Trust", humanize(it)) }
                        s.strings("recommendedForRoles").takeIf { it.isNotEmpty() }?.let { Detail("Recommended for", it.joinToString()) }
                        s.strings("requires").takeIf { it.isNotEmpty() }?.let { Detail("Requires", it.joinToString()) }
                        s.obj("source")?.str("url")?.let { Detail("Source", it) }
                    }
                }
            }
            item {
                ActionMessages(runner)
                Button(enabled = !runner.busy, onClick = {
                    runner.run {
                        val res = api.installCatalogSkill(companyId, catalogId) as? JsonObject
                        val warnings = res?.strings("warnings").orEmpty()
                        runner.notice = (res?.str("action")?.let(::humanize) ?: "Installed") +
                            if (warnings.isEmpty()) "" else " — " + warnings.joinToString("; ")
                        onInstalled(res?.obj("skill")?.str("id"))
                    }
                }) { Text(if (runner.busy) "Installing…" else "Install") }
            }
            md?.let { item { HorizontalDivider() }; item { Markdown(it) } }
        }
    }
}

/** Agent "Skills" tab: toggle company skills on this agent through the skills sync endpoint. */
@Composable
fun AgentSkillsTab(api: PaperclipApi, companyId: String, agentId: String) {
    var version by remember { mutableIntStateOf(0) }
    val runner = rememberActionRunner()
    val state = rememberLoad(agentId, version) {
        val snapshot = api.agentSkills(agentId) as JsonObject
        val library = runCatching { api.skills(companyId).asItems() }.getOrDefault(emptyList())
        snapshot to library
    }
    LoadedContent(state) { (snap, library) ->
        if (snap.bool("supported") == false) {
            EmptyState("This agent's adapter (${snap.str("adapterType") ?: "unknown"}) does not support skills.")
            return@LoadedContent
        }
        val desired = snap.strings("desiredSkills").toSet()
        val entries = snap.arr("entries").associateBy { it.str("key").orEmpty() }
        val rows = (library.mapNotNull { it.str("key")?.let { k -> k to it.titleText() } } +
            entries.keys.filter { k -> library.none { it.str("key") == k } }.map { it to (entries[it]?.str("runtimeName") ?: it) })
            .distinctBy { it.first }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
            item { ActionMessages(runner) }
            snap.strings("warnings").forEach { w -> item { Text(w, color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)) } }
            if (rows.isEmpty()) item { EmptyState("No skills in the company library") }
            items(rows, key = { it.first }) { (key, name) ->
                val entry = entries[key]
                val on = key in desired
                val readOnly = entry?.bool("readOnly") == true
                Row(Modifier.fillMaxWidth().clickable(enabled = !readOnly && !runner.busy) {
                    runner.run { api.syncAgentSkills(agentId, if (on) "remove" else "add", listOf(key)); version++ }
                }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(name, style = MaterialTheme.typography.bodyLarge)
                        Text(listOfNotNull(entry?.str("state")?.let(::humanize), entry?.str("originLabel", "locationLabel"))
                            .joinToString(" · ").ifEmpty { key },
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = on, enabled = !readOnly && !runner.busy, onCheckedChange = {
                        runner.run { api.syncAgentSkills(agentId, if (on) "remove" else "add", listOf(key)); version++ }
                    })
                }
            }
        }
    }
}
