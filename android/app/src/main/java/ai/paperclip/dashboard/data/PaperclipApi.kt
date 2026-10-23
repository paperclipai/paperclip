package ai.paperclip.dashboard.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ApiException(val code: Int, message: String) : Exception(message)

data class SignedInUser(val name: String?, val email: String?)

/** Thin client for the Paperclip REST API (`/api`), matching the clients in ui/src/api. */
class PaperclipApi(private val store: SessionStore) {
    companion object {
        /** Issues per page; a full page means "Load more" may find more. */
        const val ISSUE_PAGE = 100
    }

    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    /** Called on any 401 so the app can drop back to the sign-in screen. */
    var onUnauthorized: (() -> Unit)? = null

    private val client = OkHttpClient.Builder()
        .cookieJar(store.cookieJar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()

    // board-mutation-guard.ts rejects cookie-session mutations without a same-origin Origin header.
    private fun origin(): String {
        val u = store.baseUrl.toHttpUrl()
        val defaultPort = if (u.scheme == "https") 443 else 80
        return "${u.scheme}://${u.host}" + if (u.port != defaultPort) ":${u.port}" else ""
    }

    suspend fun raw(method: String, path: String, body: JsonElement? = null): String = withContext(Dispatchers.IO) {
        val url = store.baseUrl + "/api" + path
        val requestBody = when {
            body != null -> json.encodeToString(JsonElement.serializer(), body).toRequestBody(jsonType)
            method == "GET" -> null
            else -> "{}".toRequestBody(jsonType)
        }
        val req = Request.Builder().url(url).method(method, requestBody).header("Accept", "application/json")
        if (method != "GET") req.header("Origin", origin())
        store.boardKey.takeIf { it.isNotBlank() }?.let { req.header("Authorization", "Bearer $it") }
        client.newCall(req.build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                if (res.code == 401) onUnauthorized?.invoke()
                throw ApiException(res.code, errorMessage(text, res.code))
            }
            text
        }
    }

    private fun errorMessage(text: String, code: Int): String {
        val parsed = runCatching {
            val obj = json.parseToJsonElement(text).jsonObject
            (obj["error"] ?: obj["message"])?.jsonPrimitive?.contentOrNull
        }.getOrNull()
        return parsed ?: "HTTP $code"
    }

    suspend inline fun <reified T> get(path: String): T = json.decodeFromString(raw("GET", path))
    suspend inline fun <reified T> post(path: String, body: JsonObject = JsonObject(emptyMap())): T =
        json.decodeFromString(raw("POST", path, body))
    suspend inline fun <reified T> patch(path: String, body: JsonObject): T =
        json.decodeFromString(raw("PATCH", path, body))

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // --- Auth (better-auth) ---

    suspend fun signIn(email: String, password: String) {
        raw("POST", "/auth/sign-in/email", buildJsonObject {
            put("email", email)
            put("password", password)
        })
    }

    suspend fun signUp(name: String, email: String, password: String) {
        raw("POST", "/auth/sign-up/email", buildJsonObject {
            put("name", name)
            put("email", email)
            put("password", password)
        })
    }

    /** Claims instance ownership with the one-time URL the server prints on first authenticated startup. */
    suspend fun claimBoard(token: String, code: String) {
        raw("POST", "/board-claim/$token/claim", buildJsonObject { put("code", code) })
    }

    /** Returns null when no browser-style session exists (e.g. board key or local_trusted mode). */
    suspend fun currentUser(): SignedInUser? {
        val text = try {
            raw("GET", "/auth/get-session")
        } catch (e: ApiException) {
            if (e.code == 401 || e.code == 404) return null else throw e
        }
        val root = runCatching { json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
        val session = (root["data"] as? JsonObject) ?: root
        val user = session["user"] as? JsonObject ?: return null
        return SignedInUser(
            name = user["name"]?.jsonPrimitive?.contentOrNull,
            email = user["email"]?.jsonPrimitive?.contentOrNull,
        )
    }

    suspend fun signOut() {
        runCatching { raw("POST", "/auth/sign-out") }
        store.clearAuth()
    }

    // --- Companies & dashboard ---

    suspend fun companies(): List<Company> = get("/companies?scope=accessible")
    suspend fun dashboard(companyId: String): DashboardSummary = get("/companies/$companyId/dashboard")

    // --- Issues ---

    /** [filter] is extra query string, e.g. `projectId=…` or `touchedByUserId=me` for the inbox. */
    suspend fun issues(companyId: String, status: String?, query: String?, filter: String? = null, offset: Int = 0): List<Issue> {
        val qs = buildList {
            add("limit=$ISSUE_PAGE")
            if (offset > 0) add("offset=$offset")
            status?.let { add("status=${enc(it)}") }
            query?.takeIf { it.isNotBlank() }?.let { add("q=${enc(it)}") }
            filter?.let { add(it) }
        }.joinToString("&")
        return get("/companies/$companyId/issues?$qs")
    }

    suspend fun issue(id: String): Issue = get("/issues/$id")

    /** Newest 200 comments, oldest first. Fetching desc keeps a long thread from hiding its latest replies. */
    suspend fun issueComments(id: String): List<IssueComment> =
        get<List<IssueComment>>("/issues/$id/comments?order=desc&limit=200").asReversed()

    /** [reopen] reopens a closed issue; [interrupt] steers the agent's running run. */
    suspend fun addIssueComment(id: String, body: String, reopen: Boolean = false, interrupt: Boolean = false): IssueComment =
        post("/issues/$id/comments", buildJsonObject {
            put("body", body)
            put("clientRequestId", java.util.UUID.randomUUID().toString())
            if (reopen) put("reopen", true)
            if (interrupt) put("interrupt", true)
        })

    suspend fun deleteIssueComment(issueId: String, commentId: String) {
        raw("DELETE", "/issues/$issueId/comments/$commentId")
    }

    suspend fun markIssueRead(id: String) { raw("POST", "/issues/$id/read") }
    suspend fun markIssueUnread(id: String) { raw("DELETE", "/issues/$id/read") }
    suspend fun archiveFromInbox(id: String) { raw("POST", "/issues/$id/inbox-archive") }
    suspend fun unarchiveFromInbox(id: String) { raw("DELETE", "/issues/$id/inbox-archive") }
    suspend fun deleteIssue(id: String) { raw("DELETE", "/issues/$id") }

    suspend fun issueRuns(id: String): List<IssueRun> = get("/issues/$id/runs")
    suspend fun issueActivity(id: String): List<ActivityEvent> = get("/issues/$id/activity")
    suspend fun subIssues(companyId: String, parentId: String): List<Issue> =
        get("/companies/$companyId/issues?parentId=$parentId&limit=200")

    suspend fun labels(companyId: String): List<IssueLabel> = get("/companies/$companyId/labels")
    suspend fun createLabel(companyId: String, name: String, color: String): IssueLabel =
        post("/companies/$companyId/labels", buildJsonObject { put("name", name); put("color", color) })

    suspend fun issueDocuments(id: String): List<IssueDocumentSummary> = get("/issues/$id/documents")
    suspend fun issueDocument(id: String, key: String): IssueDocument = get("/issues/$id/documents/${enc(key)}")

    /** [baseRevisionId] makes the server reject the save if someone else changed the document meanwhile. */
    suspend fun saveIssueDocument(id: String, key: String, title: String?, body: String, baseRevisionId: String?) {
        raw("PUT", "/issues/$id/documents/${enc(key)}", buildJsonObject {
            title?.let { put("title", it) }
            put("format", "markdown")
            put("body", body)
            baseRevisionId?.let { put("baseRevisionId", it) }
        })
    }

    suspend fun issueAttachments(id: String): List<IssueAttachment> = get("/issues/$id/attachments")

    /** Raw bytes of an attachment, for viewing or sharing. */
    suspend fun download(path: String): ByteArray = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(store.baseUrl + path)
        store.boardKey.takeIf { it.isNotBlank() }?.let { req.header("Authorization", "Bearer $it") }
        client.newCall(req.build()).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "HTTP ${res.code}")
            res.body?.bytes() ?: ByteArray(0)
        }
    }

    suspend fun uploadAttachment(companyId: String, issueId: String, name: String, mime: String, bytes: ByteArray) {
        withContext(Dispatchers.IO) {
            val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
                .addFormDataPart("file", name, bytes.toRequestBody(mime.toMediaTypeOrNull()))
                .build()
            val req = Request.Builder().url(store.baseUrl + "/api/companies/$companyId/issues/$issueId/attachments")
                .post(body).header("Origin", origin())
            store.boardKey.takeIf { it.isNotBlank() }?.let { req.header("Authorization", "Bearer $it") }
            client.newCall(req.build()).execute().use { res ->
                if (!res.isSuccessful) throw ApiException(res.code, errorMessage(res.body?.string().orEmpty(), res.code))
            }
        }
    }

    suspend fun deleteAttachment(id: String) { raw("DELETE", "/attachments/$id") }

    suspend fun interactions(id: String): List<IssueInteraction> = get("/issues/$id/interactions")

    /** action is accept | reject | respond | skip | cancel. */
    suspend fun resolveInteraction(issueId: String, interactionId: String, action: String, body: JsonObject = JsonObject(emptyMap())) {
        raw("POST", "/issues/$issueId/interactions/$interactionId/$action", body)
    }

    /** Wakes the assignee to work on this issue now. */
    suspend fun wakeAgentForIssue(agentId: String, companyId: String, issueId: String) {
        raw("POST", "/agents/$agentId/wakeup?companyId=$companyId", buildJsonObject {
            put("source", "on_demand")
            put("triggerDetail", "manual")
            put("reason", "Woken from the mobile app")
            put("payload", buildJsonObject { put("issueId", issueId) })
        })
    }

    // --- Inbox ---

    suspend fun inbox(companyId: String, tab: String): List<Issue> {
        val common = "includeRoutineExecutions=true&limit=200"
        val qs = when (tab) {
            "mine" -> "touchedByUserId=me&inboxArchivedByUserId=me&status=$INBOX_MINE_STATUSES&$common"
            "unread" -> "unreadForUserId=me&inboxArchivedByUserId=me&$common"
            "blocked" -> "attention=blocked&$common"
            else -> common
        }
        return get("/companies/$companyId/issues?$qs")
    }

    suspend fun joinRequests(companyId: String): List<JoinRequest> =
        get("/companies/$companyId/join-requests?status=pending_approval")

    /** decision is approve | reject. */
    suspend fun decideJoinRequest(companyId: String, requestId: String, decision: String) {
        raw("POST", "/companies/$companyId/join-requests/$requestId/$decision")
    }

    suspend fun inboxDismissals(companyId: String): List<InboxDismissal> = get("/companies/$companyId/inbox-dismissals")
    suspend fun dismissInboxItem(companyId: String, itemKey: String) {
        raw("POST", "/companies/$companyId/inbox-dismissals", buildJsonObject { put("itemKey", itemKey); put("kind", "dismiss") })
    }

    // --- Runs ---

    suspend fun runs(companyId: String, agentId: String? = null, limit: Int = 100): List<HeartbeatRun> =
        get("/companies/$companyId/heartbeat-runs?summary=true&limit=$limit" + (agentId?.let { "&agentId=$it" } ?: ""))

    suspend fun liveRuns(companyId: String): List<HeartbeatRun> = get("/companies/$companyId/live-runs?minCount=10&limit=30")
    suspend fun run(id: String): HeartbeatRun = get("/heartbeat-runs/$id")
    suspend fun runLog(id: String, offset: Long): RunLogPage = get("/heartbeat-runs/$id/log?offset=$offset&limitBytes=256000")
    suspend fun runEvents(id: String, afterSeq: Int = 0): List<RunEvent> = get("/heartbeat-runs/$id/events?afterSeq=$afterSeq&limit=500")
    suspend fun runIssues(id: String): List<Issue> = get("/heartbeat-runs/$id/issues")
    suspend fun cancelRun(id: String) { raw("POST", "/heartbeat-runs/$id/cancel") }

    // --- Chats ---

    suspend fun chats(companyId: String): List<Issue> = get("/companies/$companyId/chats")

    /** Returns the chat issue with [agentRef], creating it if none exists. */
    suspend fun openChat(companyId: String, agentRef: String): Issue {
        val existing = runCatching { json.parseToJsonElement(raw("GET", "/companies/$companyId/chats/${enc(agentRef)}")) }.getOrNull()
        if (existing is JsonObject) return json.decodeFromJsonElement(Issue.serializer(), existing)
        return post("/companies/$companyId/chats/${enc(agentRef)}")
    }

    /** Opens the company live-event socket. Caller closes it. */
    fun liveEvents(companyId: String, listener: okhttp3.WebSocketListener): okhttp3.WebSocket {
        val url = store.baseUrl.replaceFirst("http", "ws") + "/api/companies/$companyId/events/ws"
        val req = Request.Builder().url(url).header("Origin", origin())
        store.boardKey.takeIf { it.isNotBlank() }?.let { req.header("Authorization", "Bearer $it") }
        return client.newWebSocket(req.build(), listener)
    }

    suspend fun updateIssue(id: String, fields: JsonObject) {
        raw("PATCH", "/issues/$id", fields)
    }

    suspend fun createIssue(
        companyId: String, title: String, description: String, priority: String, assigneeAgentId: String?,
        parentId: String? = null, projectId: String? = null,
    ): Issue =
        post("/companies/$companyId/issues", buildJsonObject {
            put("title", title)
            if (description.isNotBlank()) put("description", description)
            put("priority", priority)
            put("status", "todo")
            assigneeAgentId?.let { put("assigneeAgentId", it) }
            parentId?.let { put("parentId", it) }
            projectId?.let { put("projectId", it) }
        })

    // --- Agents ---

    suspend fun agents(companyId: String): List<Agent> = get("/companies/$companyId/agents")
    suspend fun agent(id: String, companyId: String): Agent = get("/agents/$id?companyId=$companyId")
    suspend fun pauseAgent(id: String, companyId: String) { raw("POST", "/agents/$id/pause?companyId=$companyId") }
    suspend fun resumeAgent(id: String, companyId: String) { raw("POST", "/agents/$id/resume?companyId=$companyId") }
    suspend fun invokeAgent(id: String, companyId: String) { raw("POST", "/agents/$id/heartbeat/invoke?companyId=$companyId") }
    suspend fun clearAgentError(id: String, companyId: String) { raw("POST", "/agents/$id/clear-error?companyId=$companyId") }
    suspend fun terminateAgent(id: String, companyId: String) { raw("POST", "/agents/$id/terminate?companyId=$companyId") }
    suspend fun approveAgent(id: String, companyId: String) { raw("POST", "/agents/$id/approve?companyId=$companyId") }
    suspend fun updateAgent(id: String, companyId: String, fields: JsonObject) { raw("PATCH", "/agents/$id?companyId=$companyId", fields) }
    suspend fun agentRuntimeState(id: String, companyId: String): JsonObject = get("/agents/$id/runtime-state?companyId=$companyId")

    // --- Approvals ---

    suspend fun approvals(companyId: String, status: String?): List<Approval> =
        get("/companies/$companyId/approvals" + (status?.let { "?status=${enc(it)}" } ?: ""))

    suspend fun approval(id: String): Approval = get("/approvals/$id")
    suspend fun approvalIssues(id: String): List<Issue> = get("/approvals/$id/issues")
    suspend fun resubmitApproval(id: String) { raw("POST", "/approvals/$id/resubmit") }
    suspend fun approvalComments(id: String): List<ApprovalComment> = get("/approvals/$id/comments")

    suspend fun addApprovalComment(id: String, body: String) {
        raw("POST", "/approvals/$id/comments", buildJsonObject { put("body", body) })
    }

    /** decision is one of approve | reject | request-revision. */
    suspend fun decideApproval(id: String, decision: String, note: String) {
        raw("POST", "/approvals/$id/$decision", buildJsonObject {
            if (note.isNotBlank()) put("decisionNote", note)
        })
    }

    // --- Activity ---

    suspend fun activity(companyId: String): List<ActivityEvent> = get("/companies/$companyId/activity?limit=100")

    // --- Side-menu sections ---

    suspend fun sidebarBadges(companyId: String): SidebarBadges = get("/companies/$companyId/sidebar-badges")

    suspend fun search(companyId: String, q: String): SearchResponse =
        get("/companies/$companyId/search?q=${enc(q)}&limit=50")

    suspend fun projects(companyId: String): List<Project> = get("/companies/$companyId/projects")
    suspend fun project(id: String, companyId: String): Project = get("/projects/$id?companyId=$companyId")

    suspend fun goals(companyId: String): List<Goal> = get("/companies/$companyId/goals")
    suspend fun goal(id: String): Goal = get("/goals/$id")

    suspend fun updateGoal(id: String, fields: JsonObject) {
        raw("PATCH", "/goals/$id", fields)
    }

    suspend fun routines(companyId: String): List<Routine> = get("/companies/$companyId/routines")
    suspend fun routine(id: String): Routine = get("/routines/$id")
    suspend fun routineRuns(id: String): List<RoutineRunSummary> = get("/routines/$id/runs?limit=50")

    suspend fun runRoutine(id: String) {
        raw("POST", "/routines/$id/run")
    }

    suspend fun setRoutineStatus(id: String, status: String) {
        raw("PATCH", "/routines/$id", buildJsonObject { put("status", status) })
    }

    suspend fun decisions(companyId: String, status: String?): List<Decision> =
        get("/companies/$companyId/decisions" + (status?.let { "?status=${enc(it)}" } ?: ""))

    suspend fun decide(id: String, optionId: String) {
        raw("POST", "/decisions/$id/decide", buildJsonObject {
            put("optionId", optionId)
            put("idempotencyKey", java.util.UUID.randomUUID().toString())
        })
    }

    suspend fun dismissDecision(id: String) {
        raw("POST", "/decisions/$id/dismiss")
    }

    suspend fun costSummary(companyId: String): CostSummary = get("/companies/$companyId/costs/summary")
    suspend fun costsByAgent(companyId: String): List<CostByAgent> = get("/companies/$companyId/costs/by-agent")
    suspend fun costsByProject(companyId: String): List<CostByProject> = get("/companies/$companyId/costs/by-project")

    suspend fun org(companyId: String): List<OrgNode> = get("/companies/$companyId/org")

    suspend fun company(companyId: String): Company = get("/companies/$companyId")

    suspend fun updateCompany(companyId: String, fields: JsonObject) {
        raw("PATCH", "/companies/$companyId", fields)
    }

    /** Untyped GET for sections whose shapes vary across server versions (artifacts, skills, connectors, ...). */
    suspend fun getJson(path: String): JsonElement = json.parseToJsonElement(raw("GET", path))

    /** Untyped mutation; empty responses decode as JsonNull. */
    suspend fun sendJson(method: String, path: String, body: JsonElement? = null): JsonElement =
        raw(method, path, body).let { if (it.isBlank()) kotlinx.serialization.json.JsonNull else json.parseToJsonElement(it) }

    // Skills: company library, built-in catalog, imports (GitHub, URL, skills.sh) and agent assignment.

    suspend fun skills(companyId: String, query: String = ""): JsonElement =
        getJson("/companies/$companyId/skills?sort=alphabetical" + if (query.isBlank()) "" else "&q=${enc(query)}")

    suspend fun skill(companyId: String, skillId: String): JsonElement = getJson("/companies/$companyId/skills/$skillId")

    suspend fun skillFile(companyId: String, skillId: String, path: String): JsonElement =
        getJson("/companies/$companyId/skills/$skillId/files?path=${enc(path)}")

    suspend fun skillUpdateStatus(companyId: String, skillId: String): JsonElement =
        getJson("/companies/$companyId/skills/$skillId/update-status")

    suspend fun installSkillUpdate(companyId: String, skillId: String): JsonElement =
        sendJson("POST", "/companies/$companyId/skills/$skillId/install-update", JsonObject(emptyMap()))

    suspend fun deleteSkill(companyId: String, skillId: String) { raw("DELETE", "/companies/$companyId/skills/$skillId") }

    suspend fun skillCatalog(query: String = "", kind: String? = null): JsonElement =
        // The server rejects an empty q (min length 1), so only send filters that are set.
        getJson("/skills/catalog?" + listOfNotNull(
            query.trim().takeIf { it.isNotEmpty() }?.let { "q=${enc(it)}" },
            kind?.let { "kind=$it" },
        ).joinToString("&"))

    suspend fun catalogSkillFile(catalogId: String, path: String = "SKILL.md"): JsonElement =
        getJson("/skills/catalog/${enc(catalogId)}/files?path=${enc(path)}")

    suspend fun installCatalogSkill(companyId: String, catalogId: String, force: Boolean = false): JsonElement =
        sendJson("POST", "/companies/$companyId/skills/install-catalog", buildJsonObject {
            put("catalogSkillId", catalogId); put("force", force)
        })

    /** Accepts owner/repo, owner/repo/skill, GitHub or skills.sh URLs, raw HTTPS URLs or `npx skills add ...`. */
    suspend fun importSkill(companyId: String, source: String): JsonElement =
        sendJson("POST", "/companies/$companyId/skills/import", buildJsonObject { put("source", source) })

    suspend fun skillSources(companyId: String): JsonElement = getJson("/companies/$companyId/skill-sources")

    suspend fun refreshSkillSource(companyId: String, sourceId: String): JsonElement =
        sendJson("POST", "/companies/$companyId/skill-sources/$sourceId/refresh", JsonObject(emptyMap()))

    suspend fun deleteSkillSource(companyId: String, sourceId: String, revision: Int, keepCopies: Boolean) {
        raw("DELETE", "/companies/$companyId/skill-sources/$sourceId", buildJsonObject {
            put("revision", revision); put("skills", if (keepCopies) "copy" else "delete")
        })
    }

    suspend fun agentSkills(agentId: String): JsonElement = getJson("/agents/$agentId/skills")

    suspend fun syncAgentSkills(agentId: String, mode: String, keys: List<String>): JsonElement =
        sendJson("POST", "/agents/$agentId/skills/sync", buildJsonObject {
            put("mode", mode)
            put("desiredSkills", kotlinx.serialization.json.JsonArray(keys.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        })

    // Plugins: instance-wide; installs come from npm or the bundled examples. Writes need an instance admin.

    suspend fun plugins(): JsonElement = getJson("/plugins")

    suspend fun pluginExamples(): JsonElement = getJson("/plugins/examples")

    suspend fun plugin(id: String): JsonElement = getJson("/plugins/$id")

    suspend fun installPlugin(packageName: String, version: String?, isLocalPath: Boolean): JsonElement =
        sendJson("POST", "/plugins/install", buildJsonObject {
            put("packageName", packageName)
            if (!version.isNullOrBlank()) put("version", version)
            if (isLocalPath) put("isLocalPath", true)
        })

    suspend fun setPluginEnabled(id: String, enabled: Boolean) {
        raw("POST", "/plugins/$id/${if (enabled) "enable" else "disable"}", JsonObject(emptyMap()))
    }

    suspend fun upgradePlugin(id: String) { raw("POST", "/plugins/$id/upgrade", JsonObject(emptyMap())) }

    suspend fun uninstallPlugin(id: String, purge: Boolean) { raw("DELETE", "/plugins/$id" + if (purge) "?purge=true" else "") }

    suspend fun pluginHealth(id: String): JsonElement = getJson("/plugins/$id/health")

    suspend fun pluginLogs(id: String): JsonElement = getJson("/plugins/$id/logs?limit=100")

    suspend fun pluginConfig(id: String, companyId: String): JsonElement = getJson("/plugins/$id/config?companyId=$companyId")

    suspend fun savePluginConfig(id: String, companyId: String, config: JsonObject, test: Boolean = false): JsonElement =
        sendJson("POST", "/plugins/$id/config" + if (test) "/test" else "", buildJsonObject {
            put("companyId", companyId); put("configJson", config)
        })

    suspend fun secrets(companyId: String): JsonElement = getJson("/companies/$companyId/secrets")
}
