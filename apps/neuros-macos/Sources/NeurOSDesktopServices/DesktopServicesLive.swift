import Foundation
import NeurOSAppCore

public actor PreviewOperationsSnapshotProvider: OperationsSnapshotProviding {
    public init() {}

    public func loadSnapshot() async throws -> OperationsSnapshot {
        return OperationsSnapshot(
            companies: [
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
            ],
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
            ]
        )
    }
}

public actor HybridConnectionStateProvider: ConnectionStateProviding {
    public init() {}

    public func currentConnectionState() async -> ConnectionState {
        .local(nodeName: Host.current().localizedName ?? "neurOS node")
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

public extension DesktopServices {
    static let preview = DesktopServices(
        operations: PreviewOperationsSnapshotProvider(),
        connection: HybridConnectionStateProvider(),
        loginItem: StubLoginItemController(),
        notifications: StubNotificationsAuthorizer(),
        localNetwork: BonjourDiscoveryService(),
        primaryNode: ManualPrimaryNodePromoter()
    )
}
