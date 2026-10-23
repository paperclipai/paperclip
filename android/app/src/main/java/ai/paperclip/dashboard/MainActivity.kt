package ai.paperclip.dashboard

import ai.paperclip.dashboard.ui.RunDetailScreen
import ai.paperclip.dashboard.ui.IssueDocumentScreen
import ai.paperclip.dashboard.ui.RunsScreen
import ai.paperclip.dashboard.ui.ChatsScreen
import ai.paperclip.dashboard.ui.LiveRunsScreen
import ai.paperclip.dashboard.ui.InboxScreen
import ai.paperclip.dashboard.ui.ActivityScreen
import ai.paperclip.dashboard.ui.AgentDetailScreen
import ai.paperclip.dashboard.ui.AgentsScreen
import ai.paperclip.dashboard.ui.ApprovalDetailScreen
import ai.paperclip.dashboard.ui.ApprovalsScreen
import ai.paperclip.dashboard.ui.CostsScreen
import ai.paperclip.dashboard.ui.DashboardScreen
import ai.paperclip.dashboard.ui.DecisionDetailScreen
import ai.paperclip.dashboard.ui.DecisionsScreen
import ai.paperclip.dashboard.ui.EmptyState
import ai.paperclip.dashboard.ui.GoalDetailScreen
import ai.paperclip.dashboard.ui.GoalsScreen
import ai.paperclip.dashboard.ui.IssueDetailScreen
import ai.paperclip.dashboard.ui.IssuesScreen
import ai.paperclip.dashboard.ui.JsonDetailScreen
import ai.paperclip.dashboard.ui.JsonListScreen
import ai.paperclip.dashboard.ui.HireAgentScreen
import ai.paperclip.dashboard.ui.ProjectEditScreen
import ai.paperclip.dashboard.ui.GoalEditScreen
import ai.paperclip.dashboard.ui.RoutineEditScreen
import ai.paperclip.dashboard.ui.SkillsScreen
import ai.paperclip.dashboard.ui.SkillDetailScreen
import ai.paperclip.dashboard.ui.CatalogSkillScreen
import ai.paperclip.dashboard.ui.PluginsScreen
import ai.paperclip.dashboard.ui.PluginDetailScreen
import ai.paperclip.dashboard.ui.LoginScreen
import ai.paperclip.dashboard.ui.NewIssueScreen
import ai.paperclip.dashboard.ui.OrgChartScreen
import ai.paperclip.dashboard.ui.PaperclipTheme
import ai.paperclip.dashboard.ui.ProjectDetailScreen
import ai.paperclip.dashboard.ui.ProjectsScreen
import ai.paperclip.dashboard.ui.RoutineDetailScreen
import ai.paperclip.dashboard.ui.RoutinesScreen
import ai.paperclip.dashboard.ui.SearchScreen
import ai.paperclip.dashboard.ui.SettingsScreen
import ai.paperclip.dashboard.ui.statusColor
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachMoney
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Power
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Sensors
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handlePairingIntent(intent)
        enableEdgeToEdge()
        setContent {
            PaperclipTheme {
                Surface(Modifier.fillMaxSize()) {
                    when (vm.phase) {
                        Phase.Checking -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                        Phase.SignedOut -> LoginScreen(
                            vm.store.baseUrl, false, vm.error,
                            onScanned = { link -> vm.pair(link) },
                        ) { u, e, p, k, n, c -> vm.signIn(u, e, p, k, n, c) }
                        Phase.Ready -> DashboardApp(vm)
                    }
                    vm.pendingPairing?.let { (url, _) -> ConfirmPairingDialog(url, vm::confirmPairing, vm::cancelPairing) }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairingIntent(intent)
    }

    private fun handlePairingIntent(intent: Intent?) {
        val link = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString ?: return
        if (!vm.pair(link)) Toast.makeText(this, "Invalid Paperclip pairing link", Toast.LENGTH_LONG).show()
    }
}

/** Asks before switching servers, because any app or web page can open a pairing link. */
@Composable
private fun ConfirmPairingDialog(url: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val insecure = url.startsWith("http://")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Connect to this server?") },
        text = {
            Text(
                "The app will sign in to $url with full board access." +
                    (if (insecure) " The connection is not encrypted, so use it only on a trusted network or tailnet." else "") +
                    " Only continue if you created this pairing code yourself.",
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Connect") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A top-level destination reachable from the side menu (and, for some, the bottom bar). */
private data class Section(val route: String, val label: String, val icon: ImageVector)

private val DASHBOARD = Section("dashboard", "Dashboard", Icons.Default.Dashboard)
private val SEARCH = Section("search", "Search", Icons.Default.Search)
private val INBOX = Section("inbox", "Inbox", Icons.Default.Inbox)
private val APPROVALS = Section("approvals", "Approvals", Icons.Default.TaskAlt)
private val DECISIONS = Section("decisions", "Decisions", Icons.Default.Checklist)
private val TASKS = Section("issues", "Tasks", Icons.Default.CheckCircle)
private val PROJECTS = Section("projects", "Projects", Icons.Default.Folder)
private val ROUTINES = Section("routines", "Routines", Icons.Default.Repeat)
private val ARTIFACTS = Section("artifacts", "Artifacts", Icons.Default.Inventory2)
private val GOALS = Section("goals", "Goals", Icons.Default.Flag)
private val WORKSPACES = Section("workspaces", "Workspaces", Icons.Default.AccountTree)
private val AGENTS = Section("agents", "Agents", Icons.Default.SmartToy)
private val ORG = Section("org", "Org chart", Icons.Default.AccountBalance)
private val SKILLS = Section("skills", "Skills", Icons.Default.Build)
private val PLUGINS = Section("plugins", "Plugins", Icons.Default.Extension)
private val CONNECTORS = Section("connectors", "Connectors", Icons.Default.Power)
private val MEMBERS = Section("members", "Members", Icons.Default.Group)
private val COSTS = Section("costs", "Costs", Icons.Default.AttachMoney)
private val ACTIVITY = Section("activity", "Activity", Icons.Default.History)
private val SETTINGS = Section("settings", "Settings", Icons.Default.Settings)
private val LIVE = Section("live", "Live", Icons.Default.Sensors)
private val CHATS = Section("chats", "Chats", Icons.Default.Forum)
private val RUNS = Section("runs", "Runs", Icons.Default.PlayCircle)

// Same grouping as the web sidebar (ui/src/components/Sidebar.tsx).
private val TOP_SECTIONS = listOf(SEARCH, DASHBOARD, LIVE, INBOX, CHATS, APPROVALS, DECISIONS)
private val WORK_SECTIONS = listOf(TASKS, PROJECTS, ROUTINES, ARTIFACTS, GOALS, WORKSPACES)
private val ORG_SECTIONS = listOf(AGENTS, RUNS, ORG, SKILLS, PLUGINS, CONNECTORS, MEMBERS, COSTS, ACTIVITY, SETTINGS)
private val ALL_SECTIONS = TOP_SECTIONS + WORK_SECTIONS + ORG_SECTIONS

private val BOTTOM_TABS = listOf(DASHBOARD, INBOX, TASKS, AGENTS, APPROVALS)

private fun baseRoute(route: String?) = route?.substringBefore('?')?.substringBefore('/')

private fun sectionFor(route: String?): Section? =
    route?.takeIf { '/' !in it }?.let { r -> ALL_SECTIONS.firstOrNull { it.route == baseRoute(r) } }

private fun detailTitle(route: String?): String = when (baseRoute(route)) {
    "issue" -> if (route == "issue/new") "New task" else "Task"
    "agent" -> "Agent"
    "approval" -> "Approval"
    "project" -> "Project"
    "goal" -> "Goal"
    "routine" -> "Routine"
    "decision" -> "Decision"
    "inspect" -> "Details"
    "run" -> "Run"
    "doc" -> "Document"
    "project-edit" -> "Project"
    "agent-hire" -> "Hire agent"
    "goal-edit" -> "Goal"
    "routine-edit" -> "Routine"
    "skill", "catalog" -> "Skill"
    "plugin" -> "Plugin"
    else -> "Paperclip"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardApp(vm: AppViewModel) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val section = sectionFor(route)
    val companyId = vm.companyId
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    // Switching company invalidates any open detail screen.
    LaunchedEffect(companyId) {
        if (route != null && section == null) nav.popBackStack(nav.graph.findStartDestination().id, false)
    }
    // Keep badges fresh whenever the menu opens or the top-level section changes.
    LaunchedEffect(drawer.isOpen, section) { if (drawer.isOpen || section != null) vm.refreshSidebar() }
    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }

    fun go(r: String) {
        scope.launch { drawer.close() }
        nav.navigateSection(r)
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = section != null || drawer.isOpen,
        drawerContent = {
            SideMenu(vm, currentRoute = baseRoute(route), onSection = ::go, onOpen = { r ->
                scope.launch { drawer.close() }
                nav.navigate(r)
            })
        },
    ) {
        Scaffold(
            topBar = {
              Column {
                TopAppBar(
                    title = {
                        when {
                            section == DASHBOARD -> CompanySwitcher(vm)
                            section != null -> Text(section.label)
                            else -> Text(detailTitle(route))
                        }
                    },
                    navigationIcon = {
                        if (section != null) {
                            IconButton(onClick = { scope.launch { drawer.open() } }) {
                                BadgedBox(badge = { if (vm.badges.inbox + vm.badges.approvals > 0) Badge() }) {
                                    Icon(Icons.Default.Menu, "Menu")
                                }
                            }
                        } else if (route != null) {
                            IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                        }
                    },
                    actions = {
                        if (section != null && section != SEARCH) {
                            IconButton(onClick = { nav.navigateSection(SEARCH.route) }) { Icon(Icons.Default.Search, "Search") }
                        }
                    },
                )
                HorizontalDivider()
              }
            },
            bottomBar = {
                if (section != null && section in BOTTOM_TABS) {
                  Column {
                    HorizontalDivider()
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
                        BOTTOM_TABS.forEach { tab ->
                            val count = when (tab) {
                                INBOX -> vm.badges.inbox
                                APPROVALS -> vm.badges.approvals
                                else -> 0
                            }
                            NavigationBarItem(
                                selected = section == tab,
                                onClick = { nav.navigateSection(tab.route) },
                                icon = { CountBadge(count) { Icon(tab.icon, null) } },
                                label = { Text(tab.label, maxLines = 1) },
                            )
                        }
                    }
                  }
                }
            },
        ) { padding ->
            Box(Modifier.padding(padding)) {
                if (companyId == null) {
                    EmptyState("No companies are accessible with this account.")
                } else {
                    AppNavHost(nav, vm, companyId)
                }
            }
        }
    }
}

@Composable
private fun CountBadge(count: Int, content: @Composable () -> Unit) {
    BadgedBox(badge = { if (count > 0) Badge { Text(if (count > 99) "99+" else count.toString()) } }) { content() }
}

@Composable
private fun SideMenu(vm: AppViewModel, currentRoute: String?, onSection: (String) -> Unit, onOpen: (String) -> Unit) {
    ModalDrawerSheet {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
            Spacer(Modifier.height(12.dp))
            CompanySwitcher(vm)
            NavigationDrawerItem(
                label = { Text("New task") },
                icon = { Icon(Icons.Default.Edit, null) },
                selected = false,
                onClick = { onOpen("issue/new") },
            )
            TOP_SECTIONS.forEach { s -> MenuItem(s, currentRoute, badgeFor(vm, s), onSection) }

            MenuHeader("Work")
            WORK_SECTIONS.forEach { s -> MenuItem(s, currentRoute, 0, onSection) }

            if (vm.projects.isNotEmpty()) {
                MenuHeader("Projects")
                vm.projects.sortedBy { it.name.lowercase() }.forEach { p ->
                    NavigationDrawerItem(
                        label = { Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        icon = { Icon(Icons.Default.Folder, null, Modifier.size(18.dp)) },
                        selected = false,
                        onClick = { onOpen("project/${p.id}") },
                    )
                }
            }

            val agents = vm.agentsById.values.filter { it.status != "terminated" }.sortedBy { it.name.lowercase() }
            if (agents.isNotEmpty()) {
                MenuHeader("Agents")
                agents.forEach { a ->
                    NavigationDrawerItem(
                        label = { Text(a.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        icon = { Box(Modifier.size(10.dp).background(statusColor(a.status), CircleShape)) },
                        badge = { if (a.status == "running" || a.status == "error") Text(a.status, style = MaterialTheme.typography.labelSmall) },
                        selected = false,
                        onClick = { onOpen("agent/${a.id}") },
                    )
                }
            }

            MenuHeader("Organization")
            ORG_SECTIONS.forEach { s -> MenuItem(s, currentRoute, 0, onSection) }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Text(vm.user?.name ?: vm.user?.email ?: "Board", style = MaterialTheme.typography.labelLarge)
                Text(vm.store.baseUrl, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            NavigationDrawerItem(
                label = { Text("Reconnect") },
                icon = { Icon(Icons.Default.Refresh, null) },
                selected = false,
                onClick = { vm.connect() },
            )
            NavigationDrawerItem(
                label = { Text("Sign out") },
                icon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                selected = false,
                onClick = { vm.signOut() },
            )
            Spacer(Modifier.height(12.dp))
        }
    }
}

private fun badgeFor(vm: AppViewModel, s: Section): Int = when (s) {
    INBOX -> vm.badges.inbox
    APPROVALS -> vm.badges.approvals
    else -> 0
}

@Composable
private fun MenuHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun MenuItem(s: Section, currentRoute: String?, count: Int, onSection: (String) -> Unit) {
    NavigationDrawerItem(
        label = { Text(s.label) },
        icon = { Icon(s.icon, null) },
        badge = { if (count > 0) Text(count.toString(), style = MaterialTheme.typography.labelMedium) },
        selected = currentRoute == s.route,
        onClick = { onSection(s.route) },
    )
}

private fun NavHostController.navigateSection(route: String) {
    navigate(route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

@Composable
private fun AppNavHost(nav: NavHostController, vm: AppViewModel, companyId: String) {
    val api = vm.api
    val agents = vm.agentsById
    val openIssue = { id: String -> nav.navigate("issue/$id") }
    val openAgent = { id: String -> nav.navigate("agent/$id") }
    val newIssue = { nav.navigate("issue/new") }
    val openRun = { id: String -> nav.navigate("run/$id") }
    val inspect = { o: JsonObject ->
        vm.inspected = o
        nav.navigate("inspect")
    }
    NavHost(nav, startDestination = DASHBOARD.route) {
        composable(DASHBOARD.route) {
            DashboardScreen(
                api, companyId,
                onOpenIssues = { status -> nav.navigate(if (status == null) "issues" else "issues?status=$status") { launchSingleTop = true } },
                onOpenAgents = { nav.navigateSection(AGENTS.route) },
                onOpenApprovals = { nav.navigateSection(APPROVALS.route) },
            )
        }
        composable(SEARCH.route) {
            SearchScreen(api, companyId) { r ->
                when (r.type) {
                    "issue" -> openIssue(r.id)
                    "agent" -> openAgent(r.id)
                    "project" -> nav.navigate("project/${r.id}")
                    "goal" -> nav.navigate("goal/${r.id}")
                    "approval" -> nav.navigate("approval/${r.id}")
                    "routine" -> nav.navigate("routine/${r.id}")
                    else -> inspect(buildJsonObject {
                        put("title", r.title)
                        put("type", r.type)
                        put("source", r.sourceLabel)
                        put("snippet", r.snippet)
                        put("link", vm.store.baseUrl + r.href)
                    })
                }
            }
        }
        // Inbox = tasks the signed-in board user has touched, as in the web Inbox page.
        composable(INBOX.route) {
            InboxScreen(
                api, companyId, agents, vm.badges.approvals,
                onOpen = { openIssue(it.id) },
                onOpenApprovals = { nav.navigateSection(APPROVALS.route) },
                onChanged = { vm.refreshSidebar() },
            )
        }
        composable(LIVE.route) { LiveRunsScreen(api, companyId, agents) { openRun(it.id) } }
        composable(CHATS.route) { ChatsScreen(api, companyId, agents, openIssue) }
        composable(RUNS.route) { RunsScreen(api, companyId, agents) { openRun(it.id) } }
        composable(APPROVALS.route) { ApprovalsScreen(api, companyId, agents) { nav.navigate("approval/$it") } }
        composable(DECISIONS.route) { DecisionsScreen(api, companyId, agents) { nav.navigate("decision/$it") } }
        composable(
            "issues?status={status}",
            arguments = listOf(navArgument("status") { type = NavType.StringType; nullable = true; defaultValue = null }),
        ) { e ->
            IssuesScreen(api, companyId, e.arguments?.getString("status"), agents, openIssue, newIssue)
        }
        composable(PROJECTS.route) { ProjectsScreen(api, companyId, agents, { nav.navigate("project/$it") }) { nav.navigate("project-edit/new") } }
        composable(ROUTINES.route) { RoutinesScreen(api, companyId, agents, { nav.navigate("routine/$it") }) { nav.navigate("routine-edit/new") } }
        composable(ARTIFACTS.route) { JsonListScreen(api, "/companies/$companyId/artifacts", "No artifacts", inspect) }
        composable(GOALS.route) { GoalsScreen(api, companyId, { nav.navigate("goal/$it") }) { nav.navigate("goal-edit/new") } }
        composable(WORKSPACES.route) { JsonListScreen(api, "/companies/$companyId/execution-workspaces", "No workspaces", inspect) }
        composable(AGENTS.route) { AgentsScreen(api, companyId, openAgent) { nav.navigate("agent-hire") } }
        composable("agent-hire") {
            HireAgentScreen(api, companyId, agents) { id, approvalId ->
                vm.refreshAgents()
                nav.popBackStack()
                nav.navigate(if (approvalId != null) "approval/$approvalId" else "agent/$id")
            }
        }
        composable(ORG.route) { OrgChartScreen(api, companyId, openAgent) }
        composable(SKILLS.route) { SkillsScreen(api, companyId, { nav.navigate("skill/$it") }, { nav.navigate("catalog/$it") }) }
        composable("skill/{id}") { e -> SkillDetailScreen(api, companyId, e.arguments!!.getString("id")!!, openAgent) { nav.popBackStack() } }
        composable("catalog/{id}") { e ->
            CatalogSkillScreen(api, companyId, e.arguments!!.getString("id")!!) { id -> nav.popBackStack(); id?.let { nav.navigate("skill/$it") } }
        }
        composable(PLUGINS.route) { PluginsScreen(api) { nav.navigate("plugin/$it") } }
        composable("plugin/{id}") { e -> PluginDetailScreen(api, companyId, e.arguments!!.getString("id")!!) { nav.popBackStack() } }
        composable(CONNECTORS.route) { JsonListScreen(api, "/companies/$companyId/tools/connections", "No connectors", inspect) }
        composable(MEMBERS.route) { JsonListScreen(api, "/companies/$companyId/members", "No members", inspect) }
        composable(COSTS.route) { CostsScreen(api, companyId, openAgent) }
        composable(ACTIVITY.route) {
            ActivityScreen(
                api, companyId, agents,
                onOpenIssue = openIssue,
                onOpenAgent = openAgent,
                onOpenApproval = { nav.navigate("approval/$it") },
            )
        }
        composable(SETTINGS.route) { SettingsScreen(api, companyId) { vm.connect() } }

        composable("issue/new") {
            NewIssueScreen(api, companyId, agents) { id ->
                nav.navigate("issue/$id") { popUpTo("issue/new") { inclusive = true } }
            }
        }
        composable("issue/{id}") { e ->
            IssueDetailScreen(
                api, e.arguments!!.getString("id")!!, agents,
                onOpenIssue = openIssue,
                onOpenRun = openRun,
                onOpenDocument = { issueId, key -> nav.navigate("doc/$issueId/$key") },
                onDeleted = { nav.popBackStack(); vm.refreshSidebar() },
            )
        }
        composable("doc/{issueId}/{key}") { e -> IssueDocumentScreen(api, e.arguments!!.getString("issueId")!!, e.arguments!!.getString("key")!!) }
        composable("run/{id}") { e -> RunDetailScreen(api, companyId, e.arguments!!.getString("id")!!, agents, openIssue) }
        composable("agent/{id}") { e -> AgentDetailScreen(api, companyId, e.arguments!!.getString("id")!!, agents, vm::refreshAgents, onOpenRun = openRun, onOpenChat = openIssue) }
        composable("approval/{id}") { e -> ApprovalDetailScreen(api, e.arguments!!.getString("id")!!, agents, openIssue) }
        composable("project/{id}") { e ->
            val id = e.arguments!!.getString("id")!!
            ProjectDetailScreen(api, companyId, id, agents, openIssue, newIssue) { nav.navigate("project-edit/$id") }
        }
        composable("project-edit/{id}") { e ->
            val id = e.arguments!!.getString("id")!!.takeIf { it != "new" }
            ProjectEditScreen(api, companyId, id, agents, onSaved = { saved ->
                nav.popBackStack()
                if (id == null) nav.navigate("project/$saved")
                vm.refreshSidebar()
            }, onDeleted = { nav.popBackStack(PROJECTS.route, inclusive = false); vm.refreshSidebar() })
        }
        composable("goal/{id}") { e ->
            val id = e.arguments!!.getString("id")!!
            GoalDetailScreen(api, id, agents, onEdit = { nav.navigate("goal-edit/$id") }, onAddSubGoal = { nav.navigate("goal-edit/new?parent=$id") })
        }
        composable("goal-edit/{id}?parent={parent}") { e ->
            val id = e.arguments!!.getString("id")!!.takeIf { it != "new" }
            GoalEditScreen(api, companyId, id, e.arguments?.getString("parent"), agents, onSaved = { saved ->
                nav.popBackStack()
                if (id == null) nav.navigate("goal/$saved")
            }, onDeleted = { nav.popBackStack(GOALS.route, inclusive = false) })
        }
        composable("routine/{id}") { e ->
            val id = e.arguments!!.getString("id")!!
            RoutineDetailScreen(api, id, agents, onEdit = { nav.navigate("routine-edit/$id") }, onOpenIssue = openIssue)
        }
        composable("routine-edit/{id}") { e ->
            val id = e.arguments!!.getString("id")!!.takeIf { it != "new" }
            RoutineEditScreen(api, companyId, id, agents) { saved ->
                nav.popBackStack()
                if (id == null) nav.navigate("routine/$saved")
            }
        }
        composable("decision/{id}") { e -> DecisionDetailScreen(api, companyId, e.arguments!!.getString("id")!!, agents, openIssue) }
        composable("inspect") { JsonDetailScreen(vm.inspected) }
    }
}

@Composable
private fun CompanySwitcher(vm: AppViewModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, enabled = vm.companies.size > 1) {
            Text(
                vm.company?.name ?: "Paperclip",
                style = MaterialTheme.typography.titleLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (vm.companies.size > 1) Icon(Icons.Default.ArrowDropDown, "Switch company", tint = MaterialTheme.colorScheme.onSurface)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            vm.companies.forEach { c ->
                DropdownMenuItem(text = { Text(c.name) }, onClick = { open = false; vm.selectCompany(c.id) })
            }
        }
    }
}
