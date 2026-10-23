package ai.paperclip.dashboard

import ai.paperclip.dashboard.data.Agent
import ai.paperclip.dashboard.data.Company
import ai.paperclip.dashboard.data.PaperclipApi
import ai.paperclip.dashboard.data.Project
import ai.paperclip.dashboard.data.SidebarBadges
import kotlinx.serialization.json.JsonObject
import ai.paperclip.dashboard.data.SessionStore
import ai.paperclip.dashboard.data.SignedInUser
import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import androidx.lifecycle.SavedStateHandle
import kotlinx.serialization.json.jsonObject

private const val INSPECTED_KEY = "inspected"

enum class Phase { Checking, SignedOut, Ready }

class AppViewModel(app: Application, private val saved: SavedStateHandle) : AndroidViewModel(app) {
    val store = SessionStore(app)
    val api = PaperclipApi(store)

    var phase by mutableStateOf(Phase.Checking)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var user by mutableStateOf<SignedInUser?>(null)
        private set
    var companies by mutableStateOf<List<Company>>(emptyList())
        private set
    var companyId by mutableStateOf(store.companyId)
        private set
    /** Agent lookup for the selected company, used to label assignees and actors. */
    var agentsById by mutableStateOf<Map<String, Agent>>(emptyMap())
        private set
    /** Badge counts and project list shown in the side menu. */
    var badges by mutableStateOf(SidebarBadges())
        private set
    var projects by mutableStateOf<List<Project>>(emptyList())
        private set
    /**
     * Item handed from a generic list screen to its detail screen. Kept in
     * [SavedStateHandle] so the detail screen survives process death.
     */
    var inspected: JsonObject?
        get() = inspectedState
        set(value) {
            inspectedState = value
            saved[INSPECTED_KEY] = value?.toString()
        }
    private var inspectedState by mutableStateOf(
        saved.get<String>(INSPECTED_KEY)?.let { runCatching { api.json.parseToJsonElement(it).jsonObject }.getOrNull() },
    )
    /** Pairing waiting for the user to confirm the server, as (url, key). */
    var pendingPairing by mutableStateOf<Pair<String, String>?>(null)
        private set

    // Only one connect/sign-in runs at a time; a newer attempt cancels the older one.
    // Declared before init, which may start the first attempt.
    private var authJob: Job? = null

    val company: Company? get() = companies.firstOrNull { it.id == companyId }

    init {
        api.onUnauthorized = {
            viewModelScope.launch {
                if (phase == Phase.Ready) {
                    error = "Session expired. Sign in again."
                    phase = Phase.SignedOut
                }
            }
        }
        if (store.baseUrl.isBlank()) phase = Phase.SignedOut else connect()
    }

    private fun launchAuth(block: suspend () -> Unit) {
        authJob?.cancel()
        authJob = viewModelScope.launch {
            phase = Phase.Checking
            error = null
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = errorMessage(e)
                phase = Phase.SignedOut
            }
        }
    }

    private suspend fun load() {
        val list = api.companies()
        user = api.currentUser()
        companies = list
        val selected = list.firstOrNull { it.id == companyId } ?: list.firstOrNull()
        selectCompany(selected?.id)
        phase = Phase.Ready
    }

    fun connect() = launchAuth { load() }

    fun signIn(
        baseUrl: String,
        email: String,
        password: String,
        boardKey: String,
        signUpName: String? = null,
        claimUrl: String = "",
    ) {
        val url = baseUrl.trim().trimEnd('/').let { if ("://" in it) it else "http://$it" }
        val parsed = url.toHttpUrlOrNull()
        if (parsed == null) {
            error = "Enter a valid server URL, such as http://100.x.y.z:3100."
            return
        }
        if (!parsed.isHttps && !isPrivateHost(parsed.host)) {
            error = "Use https:// for a server on the public internet. Plain http is only allowed on LAN, Tailscale or localhost."
            return
        }
        // Keep the working session until the new one is proven; restore it if this attempt fails.
        val previous = store.baseUrl to store.boardKey
        store.baseUrl = url
        store.boardKey = boardKey
        launchAuth {
            try {
                if (email.isNotBlank()) {
                    if (signUpName != null) api.signUp(signUpName.trim(), email.trim(), password)
                    else api.signIn(email.trim(), password)
                }
                if (claimUrl.isNotBlank()) {
                    val (token, code) = parseBoardClaimUrl(claimUrl)
                        ?: throw IllegalArgumentException("Board claim URL should look like …/board-claim/<token>?code=<code>")
                    api.claimBoard(token, code)
                }
                load()
            } catch (e: Exception) {
                store.baseUrl = previous.first
                store.boardKey = previous.second
                throw e
            }
        }
    }

    /**
     * Reads a pairing QR code or deep link. Nothing is saved until the user confirms
     * the server with [confirmPairing], so a hostile link cannot silently redirect the app.
     * Returns false for a non-pairing link.
     */
    fun pair(link: String): Boolean {
        pendingPairing = parsePairingLink(link) ?: run {
            error = "That QR code is not a Paperclip pairing code."
            return false
        }
        return true
    }

    fun confirmPairing() {
        val (url, key) = pendingPairing ?: return
        pendingPairing = null
        signIn(url, "", "", key)
    }

    fun cancelPairing() {
        pendingPairing = null
    }

    fun signOut() {
        authJob?.cancel()
        viewModelScope.launch {
            runCatching { api.signOut() }
            user = null
            companies = emptyList()
            agentsById = emptyMap()
            badges = SidebarBadges()
            projects = emptyList()
            inspected = null
            phase = Phase.SignedOut
        }
    }

    fun selectCompany(id: String?) {
        companyId = id
        store.companyId = id
        agentsById = emptyMap()
        badges = SidebarBadges()
        projects = emptyList()
        refreshSidebar()
    }

    // Each refresh drops its result if the user switched company while it was in flight.
    fun refreshAgents() {
        val id = companyId ?: return
        viewModelScope.launch {
            runCatching { api.agents(id) }.onSuccess { list -> if (companyId == id) agentsById = list.associateBy { it.id } }
        }
    }

    fun refreshSidebar() {
        val id = companyId ?: return
        refreshAgents()
        viewModelScope.launch { runCatching { api.sidebarBadges(id) }.onSuccess { if (companyId == id) badges = it } }
        viewModelScope.launch {
            runCatching { api.projects(id) }.onSuccess { list ->
                if (companyId == id) projects = list.filter { it.archivedAt == null }
            }
        }
    }
}

private fun errorMessage(e: Exception): String = when (e) {
    is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException ->
        "Can't reach the server. Check the URL and that this phone is on the same network or tailnet."
    else -> e.message ?: e.toString()
}

/** True for hosts where plain http is acceptable: loopback, private LAN, Tailscale (100.64.0.0/10, *.ts.net), mDNS and bare hostnames. */
fun isPrivateHost(host: String): Boolean {
    val h = host.lowercase().trim('[', ']')
    if (h == "localhost" || h.endsWith(".local") || h.endsWith(".ts.net") || h.endsWith(".internal")) return true
    if (h == "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return ':' in h
    val parts = h.split('.')
    if (parts.size == 4 && parts.all { p -> p.toIntOrNull()?.let { it in 0..255 } == true }) {
        val (a, b) = parts.take(2).map { it.toInt() }
        return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 100 && b in 64..127)
    }
    return '.' !in h
}

/** Parses `paperclip://connect?url=<server>&key=<board key>` from the web "Pair a phone" QR code. */
fun parsePairingLink(link: String): Pair<String, String>? {
    val uri = runCatching { java.net.URI(link.trim()) }.getOrNull() ?: return null
    if (uri.scheme != "paperclip" || uri.host != "connect") return null
    val params = uri.rawQuery.orEmpty().split('&').mapNotNull { part ->
        val i = part.indexOf('=').takeIf { it > 0 } ?: return@mapNotNull null
        java.net.URLDecoder.decode(part.substring(0, i), "UTF-8") to java.net.URLDecoder.decode(part.substring(i + 1), "UTF-8")
    }.toMap()
    val url = params["url"]?.takeIf { it.toHttpUrlOrNull() != null } ?: return null
    val key = params["key"]?.takeIf { it.isNotBlank() && it.length <= 512 } ?: return null
    return url to key
}

/** Extracts (token, code) from a board-claim URL such as `http://host:3100/board-claim/<token>?code=<code>`. */
fun parseBoardClaimUrl(url: String): Pair<String, String>? {
    val m = Regex("""board-claim/([A-Za-z0-9_-]+)\?(?:.*&)?code=([A-Za-z0-9_-]+)""").find(url.trim()) ?: return null
    return m.groupValues[1] to m.groupValues[2]
}
