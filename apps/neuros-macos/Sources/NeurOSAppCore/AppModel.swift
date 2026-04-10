import Foundation
import Observation

@MainActor
@Observable
public final class AppModel {
    public var identity: AppIdentity
    public var runtimeMode: RuntimeMode
    public var selectedSection: NavigationSection
    public var connectionState: ConnectionState
    public var companies: [CompanySummary]
    public var selectedCompanyID: CompanySummary.ID?
    public var approvals: [ApprovalSummary]
    public var signals: [OperationsSignal]
    public var agents: [AgentRuntimeSummary]
    public var isBootstrapping: Bool
    public var launchAtLoginEnabled: Bool
    public var notificationsEnabled: Bool
    public var statusMessage: String?

    public init(
        identity: AppIdentity = .current,
        runtimeMode: RuntimeMode = .hybrid,
        selectedSection: NavigationSection = .operations,
        connectionState: ConnectionState = .connecting,
        companies: [CompanySummary] = [],
        selectedCompanyID: CompanySummary.ID? = nil,
        approvals: [ApprovalSummary] = [],
        signals: [OperationsSignal] = [],
        agents: [AgentRuntimeSummary] = [],
        isBootstrapping: Bool = true,
        launchAtLoginEnabled: Bool = false,
        notificationsEnabled: Bool = true,
        statusMessage: String? = nil
    ) {
        self.identity = identity
        self.runtimeMode = runtimeMode
        self.selectedSection = selectedSection
        self.connectionState = connectionState
        self.companies = companies
        self.selectedCompanyID = selectedCompanyID
        self.approvals = approvals
        self.signals = signals
        self.agents = agents
        self.isBootstrapping = isBootstrapping
        self.launchAtLoginEnabled = launchAtLoginEnabled
        self.notificationsEnabled = notificationsEnabled
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

    public func apply(snapshot: OperationsSnapshot, connectionState: ConnectionState) {
        companies = snapshot.companies
        selectedCompanyID = selectedCompanyID ?? snapshot.companies.first?.id
        approvals = snapshot.approvals
        signals = snapshot.signals
        agents = snapshot.agents
        self.connectionState = connectionState
        isBootstrapping = false
        statusMessage = nil
    }

    public static func preview() -> AppModel {
        let companies = [
            CompanySummary(
                name: "GoldNeuron Ops",
                projectsCount: 4,
                activeIssuesCount: 52,
                activeAgentsCount: 6,
                recentSignalsCount: 2
            ),
            CompanySummary(
                name: "Agency Studio",
                projectsCount: 3,
                activeIssuesCount: 17,
                activeAgentsCount: 4,
                recentSignalsCount: 1
            ),
        ]
        return AppModel(
            connectionState: .local(nodeName: "neurOS local"),
            companies: companies,
            selectedCompanyID: companies.first?.id,
            approvals: [
                ApprovalSummary(title: "Aprovar novo squad criativo", owner: "COO Agent", priorityLabel: "Alta"),
                ApprovalSummary(title: "Liberar budget semanal", owner: "Finance Ops", priorityLabel: "Média"),
            ],
            signals: [
                OperationsSignal(title: "Runtime retomado", detail: "Todos os workers reconectados na rede local.", occurredAt: .now),
                OperationsSignal(title: "Webhook em atraso", detail: "Intake criativo aguardando revisão há 9 min.", occurredAt: .now),
            ],
            agents: [
                AgentRuntimeSummary(name: "Clara", role: "COO Agent", stateLabel: "Pronta", issueLabel: "#52 Aprovações"),
                AgentRuntimeSummary(name: "Nina", role: "Creative Lead", stateLabel: "Executando", issueLabel: "#48 Campanha"),
                AgentRuntimeSummary(name: "Kai", role: "Ops Engineer", stateLabel: "Monitorando", issueLabel: "#31 Runtime"),
            ],
            isBootstrapping: false,
            statusMessage: "Base SwiftUI inicial pronta para paridade funcional do neurOS macOS."
        )
    }
}
