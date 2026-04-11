import Foundation
import Observation

@MainActor
@Observable
public final class AppModel {
    public var identity: AppIdentity
    public var serverConfiguration: ServerConnectionConfiguration
    public var runtimeMode: RuntimeMode
    public var selectedSection: NavigationSection
    public var connectionState: ConnectionState
    public var health: ServerHealthSummary?
    public var companies: [CompanySummary]
    public var selectedCompanyID: String?
    public var dashboard: DashboardSummary?
    public var approvals: [ApprovalSummary]
    public var activity: [ActivityFeedEntry]
    public var signals: [OperationsSignal]
    public var agents: [AgentRuntimeSummary]
    public var issues: [IssueQueueSummary]
    public var goals: [GoalSummary]
    public var projects: [ProjectSummary]
    public var plugins: [PluginSummary]
    public var isBootstrapping: Bool
    public var launchAtLoginEnabled: Bool
    public var notificationsEnabled: Bool
    public var lastRefreshedAt: Date?
    public var statusMessage: String?

    public init(
        identity: AppIdentity = .current,
        serverConfiguration: ServerConnectionConfiguration = .default,
        runtimeMode: RuntimeMode = .hybrid,
        selectedSection: NavigationSection = .operations,
        connectionState: ConnectionState = .connecting,
        health: ServerHealthSummary? = nil,
        companies: [CompanySummary] = [],
        selectedCompanyID: String? = nil,
        dashboard: DashboardSummary? = nil,
        approvals: [ApprovalSummary] = [],
        activity: [ActivityFeedEntry] = [],
        signals: [OperationsSignal] = [],
        agents: [AgentRuntimeSummary] = [],
        issues: [IssueQueueSummary] = [],
        goals: [GoalSummary] = [],
        projects: [ProjectSummary] = [],
        plugins: [PluginSummary] = [],
        isBootstrapping: Bool = true,
        launchAtLoginEnabled: Bool = false,
        notificationsEnabled: Bool = true,
        lastRefreshedAt: Date? = nil,
        statusMessage: String? = nil
    ) {
        self.identity = identity
        self.serverConfiguration = serverConfiguration
        self.runtimeMode = runtimeMode
        self.selectedSection = selectedSection
        self.connectionState = connectionState
        self.health = health
        self.companies = companies
        self.selectedCompanyID = selectedCompanyID
        self.dashboard = dashboard
        self.approvals = approvals
        self.activity = activity
        self.signals = signals
        self.agents = agents
        self.issues = issues
        self.goals = goals
        self.projects = projects
        self.plugins = plugins
        self.isBootstrapping = isBootstrapping
        self.launchAtLoginEnabled = launchAtLoginEnabled
        self.notificationsEnabled = notificationsEnabled
        self.lastRefreshedAt = lastRefreshedAt
        self.statusMessage = statusMessage
    }

    public var selectedCompany: CompanySummary? {
        companies.first(where: { $0.id == selectedCompanyID }) ?? companies.first
    }

    public var totalActiveIssues: Int {
        companies.reduce(0) { $0 + $1.activeIssuesCount }
    }

    public var totalActiveAgents: Int {
        companies.reduce(0) { $0 + $1.activeAgentsCount }
    }

    public var totalRecentSignals: Int {
        companies.reduce(0) { $0 + $1.recentSignalsCount }
    }

    public var selectedCompanyName: String {
        selectedCompany?.name ?? "Sem empresa"
    }

    public var selectedCompanyStatus: String {
        selectedCompany?.status ?? "unknown"
    }

    public func apply(snapshot: OperationsSnapshot, connectionState: ConnectionState) {
        companies = snapshot.companies
        let availableIDs = Set(snapshot.companies.map(\.id))
        if let selectedCompanyID, availableIDs.contains(selectedCompanyID) {
            self.selectedCompanyID = selectedCompanyID
        } else {
            self.selectedCompanyID = snapshot.selectedCompanyID ?? snapshot.companies.first?.id
        }
        dashboard = snapshot.dashboard
        approvals = snapshot.approvals
        activity = snapshot.activity
        signals = snapshot.signals
        agents = snapshot.agents
        issues = snapshot.issues
        goals = snapshot.goals
        projects = snapshot.projects
        plugins = snapshot.plugins
        health = snapshot.health
        self.connectionState = connectionState
        isBootstrapping = false
        lastRefreshedAt = .now
        statusMessage = nil
    }

    public func makeSnapshot() -> OperationsSnapshot {
        OperationsSnapshot(
            companies: companies,
            selectedCompanyID: selectedCompanyID,
            dashboard: dashboard,
            approvals: approvals,
            activity: activity,
            signals: signals,
            agents: agents,
            issues: issues,
            goals: goals,
            projects: projects,
            plugins: plugins,
            health: health
        )
    }

    public static func preview() -> AppModel {
        let companies = [
            CompanySummary(
                id: "goldneuron-ops",
                name: "GoldNeuron Ops",
                status: "active",
                projectsCount: 4,
                activeIssuesCount: 52,
                activeAgentsCount: 6,
                recentSignalsCount: 2
            ),
            CompanySummary(
                id: "agency-studio",
                name: "Agency Studio",
                status: "active",
                projectsCount: 3,
                activeIssuesCount: 17,
                activeAgentsCount: 4,
                recentSignalsCount: 1
            ),
        ]
        return AppModel(
            serverConfiguration: .default,
            connectionState: .local(nodeName: "neurOS local"),
            health: ServerHealthSummary(
                status: "ok",
                version: "0.3.1",
                deploymentMode: "local_trusted",
                deploymentExposure: "private"
            ),
            companies: companies,
            selectedCompanyID: companies.first?.id,
            dashboard: DashboardSummary(
                openTasks: 52,
                inProgressTasks: 18,
                blockedTasks: 4,
                doneTasks: 113,
                activeAgents: 6,
                runningAgents: 3,
                pausedAgents: 1,
                erroredAgents: 0,
                pendingApprovals: 2,
                monthSpendCents: 43850,
                monthBudgetCents: 120000,
                monthUtilizationPercent: 36.5,
                activeBudgetIncidents: 1,
                pausedProjects: 1
            ),
            approvals: [
                ApprovalSummary(id: "approval-1", title: "Aprovar novo squad criativo", owner: "COO Agent", priorityLabel: "Alta", createdAt: .now),
                ApprovalSummary(id: "approval-2", title: "Liberar budget semanal", owner: "Finance Ops", priorityLabel: "Média", createdAt: .now.addingTimeInterval(-1800)),
            ],
            activity: [
                ActivityFeedEntry(
                    id: "activity-1",
                    title: "Issue Updated",
                    actorLabel: "Clara",
                    entityLabel: "GN-52 Revisar fila de aprovações",
                    detailSummary: "status: in_review, priority: high",
                    action: "issue.updated",
                    entityType: "issue",
                    createdAt: .now
                ),
                ActivityFeedEntry(
                    id: "activity-2",
                    title: "Approval Created",
                    actorLabel: "system",
                    entityLabel: "Aprovar novo squad criativo",
                    detailSummary: "type: hire_agent",
                    action: "approval.created",
                    entityType: "approval",
                    createdAt: .now.addingTimeInterval(-900)
                ),
            ],
            signals: [
                OperationsSignal(id: "signal-1", title: "Runtime retomado", detail: "Todos os workers reconectados na rede local.", occurredAt: .now),
                OperationsSignal(id: "signal-2", title: "Webhook em atraso", detail: "Intake criativo aguardando revisão há 9 min.", occurredAt: .now),
            ],
            agents: [
                AgentRuntimeSummary(id: "agent-1", name: "Clara", role: "COO Agent", stateLabel: "Pronta", issueLabel: "#52 Aprovações", budgetLabel: "R$ 120,00"),
                AgentRuntimeSummary(id: "agent-2", name: "Nina", role: "Creative Lead", stateLabel: "Executando", issueLabel: "#48 Campanha", budgetLabel: "R$ 98,00"),
                AgentRuntimeSummary(id: "agent-3", name: "Kai", role: "Ops Engineer", stateLabel: "Monitorando", issueLabel: "#31 Runtime", budgetLabel: "R$ 82,00"),
            ],
            issues: [
                IssueQueueSummary(id: "issue-1", identifier: "GN-52", title: "Revisar fila de aprovações", status: "in_review", priority: "high", assigneeLabel: "Clara", updatedAt: .now),
                IssueQueueSummary(id: "issue-2", identifier: "GN-48", title: "Subir campanha da semana", status: "in_progress", priority: "critical", assigneeLabel: "Nina", updatedAt: .now),
            ],
            goals: [
                GoalSummary(
                    id: "goal-1",
                    title: "Expandir a operação comercial",
                    description: "Coordenar aquisição, onboarding e retenção com foco em previsibilidade operacional.",
                    level: "company",
                    status: "active",
                    parentID: nil,
                    ownerLabel: "Clara",
                    createdAt: .now.addingTimeInterval(-86_400 * 14),
                    updatedAt: .now.addingTimeInterval(-7_200)
                ),
                GoalSummary(
                    id: "goal-2",
                    title: "Aumentar taxa de resposta do inbound",
                    description: "Padronizar SLA, triagem e redistribuição entre agentes de growth.",
                    level: "team",
                    status: "active",
                    parentID: "goal-1",
                    ownerLabel: "Nina",
                    createdAt: .now.addingTimeInterval(-86_400 * 10),
                    updatedAt: .now.addingTimeInterval(-3_600)
                ),
                GoalSummary(
                    id: "goal-3",
                    title: "Fechar backlog de follow-up crítico",
                    description: "Eliminar contatos críticos sem retorno em até 24 horas.",
                    level: "task",
                    status: "planned",
                    parentID: "goal-2",
                    ownerLabel: "Kai",
                    createdAt: .now.addingTimeInterval(-86_400 * 5),
                    updatedAt: .now.addingTimeInterval(-1_800)
                ),
            ],
            projects: [
                ProjectSummary(id: "project-1", name: "Growth Engine", status: "in_progress", goalIDs: ["goal-2"], workspaceCount: 2, goalCount: 1, targetDateLabel: "2026-04-18"),
                ProjectSummary(id: "project-2", name: "Ops Reliability", status: "planned", goalIDs: ["goal-1", "goal-3"], workspaceCount: 1, goalCount: 2, targetDateLabel: "Sem data"),
            ],
            plugins: [
                PluginSummary(id: "plugin-1", displayName: "Central Operações", packageName: "@paperclip/central-operacoes", version: "0.8.3", status: "ready"),
            ],
            isBootstrapping: false,
            lastRefreshedAt: .now,
            statusMessage: "Base SwiftUI inicial pronta para paridade funcional do neurOS macOS."
        )
    }
}
