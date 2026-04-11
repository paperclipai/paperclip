import Foundation
import NeurOSAppCore

public actor PreviewOperationsSnapshotProvider: OperationsSnapshotProviding, OperationsConsoleProviding {
    public init() {}

    public func loadSnapshot(
        configuration: ServerConnectionConfiguration,
        selectedCompanyID: String?
    ) async throws -> OperationsSnapshot {
        _ = configuration
        _ = selectedCompanyID
        return OperationsSnapshot(
            companies: [
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
            ],
            selectedCompanyID: "goldneuron-ops",
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
                ApprovalSummary(id: "approval-2", title: "Liberar budget semanal", owner: "Finance Ops", priorityLabel: "Média", createdAt: .now.addingTimeInterval(-1200)),
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
                OperationsSignal(title: "Runtime retomado", detail: "Todos os workers reconectados na rede local.", occurredAt: .now),
                OperationsSignal(title: "Webhook em atraso", detail: "Intake criativo aguardando revisão há 9 min.", occurredAt: .now),
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
            health: ServerHealthSummary(
                status: "ok",
                version: "0.3.1",
                deploymentMode: "local_trusted",
                deploymentExposure: "private"
            )
        )
    }

    public func loadApprovalDetail(
        configuration: ServerConnectionConfiguration,
        approvalID: String
    ) async throws -> ApprovalDetail {
        _ = configuration
        return ApprovalDetail(
            id: approvalID,
            title: "Aprovar novo squad criativo",
            owner: "COO Agent",
            type: "hire_agent",
            status: "pending",
            requestedByAgentID: "agent-1",
            requestedByUserID: nil,
            decisionNote: nil,
            createdAt: .now,
            updatedAt: .now,
            decidedAt: nil,
            payloadFields: [
                ApprovalField(key: "role", value: "Creative Lead"),
                ApprovalField(key: "priority", value: "high"),
                ApprovalField(key: "title", value: "Aprovar novo squad criativo"),
            ],
            linkedIssues: [
                IssueQueueSummary(
                    id: "issue-1",
                    identifier: "GN-52",
                    title: "Revisar fila de aprovações",
                    status: "in_review",
                    priority: "high",
                    assigneeLabel: "Clara",
                    updatedAt: .now
                )
            ],
            comments: [
                ApprovalCommentEntry(
                    id: "comment-1",
                    authorLabel: "Board",
                    body: "Validar budget antes de confirmar o hire.",
                    createdAt: .now
                )
            ]
        )
    }

    public func loadIssueDetail(
        configuration: ServerConnectionConfiguration,
        issueID: String
    ) async throws -> IssueConsoleDetail {
        _ = configuration
        return IssueConsoleDetail(
            id: issueID,
            identifier: "GN-52",
            title: "Revisar fila de aprovações",
            description: "Conferir pendências do board, alinhar prioridade e destravar decisões críticas.",
            status: "in_review",
            priority: "high",
            assigneeLabel: "Clara",
            projectLabel: "Growth Engine",
            goalLabel: "Aumentar taxa de resposta do inbound",
            parentLabel: "Expandir a operação comercial",
            blockedBy: [
                IssueQueueSummary(
                    id: "issue-blocker-1",
                    identifier: "GN-48",
                    title: "Subir campanha da semana",
                    status: "in_progress",
                    priority: "critical",
                    assigneeLabel: "Nina",
                    updatedAt: .now.addingTimeInterval(-1_200)
                )
            ],
            blocks: [],
            createdAt: .now.addingTimeInterval(-86_400 * 3),
            updatedAt: .now
        )
    }

    public func loadAgentDetail(
        configuration: ServerConnectionConfiguration,
        agentID: String
    ) async throws -> AgentConsoleDetail {
        _ = configuration
        return AgentConsoleDetail(
            id: agentID,
            name: "Clara",
            role: "COO Agent",
            title: "Chief Operating Officer",
            status: "active",
            adapterType: "codex_local",
            budgetMonthlyCents: 200_000,
            spentMonthlyCents: 120_000,
            pauseReason: nil,
            lastHeartbeatAt: .now.addingTimeInterval(-300),
            canAssignTasks: true,
            taskAssignSource: "agent_creator",
            chainOfCommand: [
                AgentChainEntry(id: "agent-1", name: "Clara", role: "COO Agent", title: "Chief Operating Officer"),
                AgentChainEntry(id: "agent-2", name: "Nina", role: "Creative Lead", title: "Creative Lead")
            ]
        )
    }

    public func addApprovalComment(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        body: String
    ) async throws -> ApprovalCommentEntry {
        _ = configuration
        return ApprovalCommentEntry(id: approvalID + "-comment", authorLabel: "Board", body: body, createdAt: .now)
    }

    public func performApprovalAction(
        configuration: ServerConnectionConfiguration,
        approvalID: String,
        action: ApprovalDecisionAction,
        note: String?
    ) async throws -> ApprovalDetail {
        _ = configuration
        return ApprovalDetail(
            id: approvalID,
            title: "Aprovar novo squad criativo",
            owner: "COO Agent",
            type: "hire_agent",
            status: action == .approve ? "approved" : action == .reject ? "rejected" : action == .requestRevision ? "needs_revision" : "pending",
            requestedByAgentID: "agent-1",
            requestedByUserID: nil,
            decisionNote: note,
            createdAt: .now,
            updatedAt: .now,
            decidedAt: .now,
            payloadFields: [ApprovalField(key: "role", value: "Creative Lead")],
            linkedIssues: [],
            comments: []
        )
    }

    public func loadPluginConsoleSnapshot(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        logLimit: Int
    ) async throws -> PluginConsoleSnapshot {
        _ = configuration
        _ = logLimit
        return PluginConsoleSnapshot(
            detail: PluginDetail(
                id: pluginID,
                displayName: "Central Operações",
                pluginKey: "@paperclip/central-operacoes",
                packageName: "@paperclip/central-operacoes",
                version: "0.8.3",
                status: "ready",
                apiVersion: 1,
                installOrder: 1,
                packagePath: "/plugins/central-operacoes",
                supportsConfigTest: true,
                lastError: nil,
                categories: ["operations", "ui"],
                launcherCount: 2,
                slotCount: 1,
                installedAt: .now,
                updatedAt: .now
            ),
            health: PluginHealthSummary(
                status: "ready",
                healthy: true,
                checks: [
                    PluginHealthCheck(name: "registry", passed: true, message: "Plugin found in registry"),
                    PluginHealthCheck(name: "manifest", passed: true, message: "Manifest is valid"),
                ],
                lastError: nil
            ),
            logs: [
                PluginLogEntry(id: "log-1", level: "info", message: "Plugin inicializado", metaSummary: "source: preview", createdAt: .now)
            ]
        )
    }

    public func setPluginEnabled(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        isEnabled: Bool,
        reason: String?
    ) async throws -> PluginDetail {
        _ = configuration
        return PluginDetail(
            id: pluginID,
            displayName: "Central Operações",
            pluginKey: "@paperclip/central-operacoes",
            packageName: "@paperclip/central-operacoes",
            version: "0.8.3",
            status: isEnabled ? "ready" : "installed",
            apiVersion: 1,
            installOrder: 1,
            packagePath: "/plugins/central-operacoes",
            supportsConfigTest: true,
            lastError: reason,
            categories: ["operations"],
            launcherCount: 1,
            slotCount: 1,
            installedAt: .now,
            updatedAt: .now
        )
    }

    public func upgradePlugin(
        configuration: ServerConnectionConfiguration,
        pluginID: String,
        targetVersion: String?
    ) async throws -> PluginDetail {
        _ = configuration
        return PluginDetail(
            id: pluginID,
            displayName: "Central Operações",
            pluginKey: "@paperclip/central-operacoes",
            packageName: "@paperclip/central-operacoes",
            version: targetVersion ?? "0.8.4",
            status: "ready",
            apiVersion: 1,
            installOrder: 1,
            packagePath: "/plugins/central-operacoes",
            supportsConfigTest: true,
            lastError: nil,
            categories: ["operations"],
            launcherCount: 1,
            slotCount: 1,
            installedAt: .now,
            updatedAt: .now
        )
    }

    public func loadProjectWorkspaces(
        configuration: ServerConnectionConfiguration,
        projectID: String
    ) async throws -> [ProjectWorkspaceDetail] {
        _ = configuration
        return [
            ProjectWorkspaceDetail(
                id: projectID + "-workspace-1",
                name: "Primary Workspace",
                sourceType: "local_path",
                visibility: "default",
                cwd: "/Users/monrars/paperclip",
                repoUrl: "https://github.com/monrars1995/paperclip",
                repoRef: "main",
                defaultRef: "main",
                desiredState: "running",
                isPrimary: true,
                runtimeServices: [
                    RuntimeServiceSummary(
                        id: "runtime-1",
                        serviceName: "api",
                        status: "running",
                        lifecycle: "shared",
                        healthStatus: "healthy",
                        port: 3100,
                        url: "http://127.0.0.1:3100"
                    )
                ],
                updatedAt: .now
            )
        ]
    }

    public func performWorkspaceRuntimeAction(
        configuration: ServerConnectionConfiguration,
        projectID: String,
        workspaceID: String,
        action: WorkspaceRuntimeAction
    ) async throws -> WorkspaceRuntimeActionResult {
        _ = configuration
        _ = projectID
        return WorkspaceRuntimeActionResult(
            workspace: ProjectWorkspaceDetail(
                id: workspaceID,
                name: "Primary Workspace",
                sourceType: "local_path",
                visibility: "default",
                cwd: "/Users/monrars/paperclip",
                repoUrl: "https://github.com/monrars1995/paperclip",
                repoRef: "main",
                defaultRef: "main",
                desiredState: action == .stop ? "stopped" : "running",
                isPrimary: true,
                runtimeServices: action == .stop ? [] : [
                    RuntimeServiceSummary(
                        id: "runtime-1",
                        serviceName: "api",
                        status: "running",
                        lifecycle: "shared",
                        healthStatus: "healthy",
                        port: 3100,
                        url: "http://127.0.0.1:3100"
                    )
                ],
                updatedAt: .now
            ),
            operationStatus: "succeeded",
            outputSummary: "Preview runtime action \(action.rawValue) executada.",
            runtimeServiceCount: action == .stop ? 0 : 1
        )
    }
}

public actor HybridConnectionStateProvider: ConnectionStateProviding {
    public init() {}

    public func currentConnectionState(configuration: ServerConnectionConfiguration) async -> ConnectionState {
        _ = configuration
        return .local(nodeName: Host.current().localizedName ?? "neurOS node")
    }
}

public actor StubLoginItemController: LoginItemControlling {
    public init() {}

    public func setEnabled(_ isEnabled: Bool) async throws {
        _ = isEnabled
    }
}

public actor StubNotificationsAuthorizer: NotificationsAuthorizing {
    public init() {}

    public func requestAuthorizationIfNeeded() async {}
}

public actor BonjourDiscoveryService: LocalNetworkDiscovering {
    public init() {}

    public func discoverPeers() async -> [String] {
        ["creative-mac.local", "ops-base.local"]
    }
}

public actor ManualPrimaryNodePromoter: PrimaryNodePromoting {
    public init() {}

    public func promoteCurrentMac() async throws -> ConnectionState {
        .local(nodeName: Host.current().localizedName ?? "neurOS node")
    }
}

public actor PreviewDesktopConfigurationStore: DesktopConfigurationStoring {
    public init() {}

    public func load() async -> ServerConnectionConfiguration { .default }

    public func save(_ configuration: ServerConnectionConfiguration) async {
        _ = configuration
    }
}

public extension DesktopServices {
    static let live: DesktopServices = {
        let paperclip = PaperclipDesktopService()
        return DesktopServices(
            operations: paperclip,
            console: paperclip,
            connection: paperclip,
            configurationStore: UserDefaultsDesktopConfigurationStore(),
            loginItem: StubLoginItemController(),
            notifications: StubNotificationsAuthorizer(),
            localNetwork: BonjourDiscoveryService(),
            primaryNode: ManualPrimaryNodePromoter()
        )
    }()

    static let preview = DesktopServices(
        operations: PreviewOperationsSnapshotProvider(),
        console: PreviewOperationsSnapshotProvider(),
        connection: HybridConnectionStateProvider(),
        configurationStore: PreviewDesktopConfigurationStore(),
        loginItem: StubLoginItemController(),
        notifications: StubNotificationsAuthorizer(),
        localNetwork: BonjourDiscoveryService(),
        primaryNode: ManualPrimaryNodePromoter()
    )
}
