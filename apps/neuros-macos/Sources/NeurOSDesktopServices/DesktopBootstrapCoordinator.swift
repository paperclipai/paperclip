import Foundation
import NeurOSAppCore

@MainActor
public final class DesktopBootstrapCoordinator {
    private let services: DesktopServices

    public init(services: DesktopServices) {
        self.services = services
    }

    public func start(appModel: AppModel) async {
        appModel.isBootstrapping = true
        let configuration = await services.configurationStore.load()
        appModel.serverConfiguration = configuration
        appModel.runtimeMode = configuration.runtimeMode
        await services.notifications.requestAuthorizationIfNeeded()

        let peers = await services.localNetwork.discoverPeers()
        if peers.isEmpty == false {
            appModel.statusMessage = "Rede local pronta com \(peers.count) nós detectados."
        }

        await refresh(appModel: appModel)
    }

    public func refresh(appModel: AppModel) async {
        let connectionState = await services.connection.currentConnectionState(configuration: appModel.serverConfiguration)
        await applySnapshot(appModel: appModel, connectionState: connectionState)
    }

    public func updateServerConfiguration(
        _ configuration: ServerConnectionConfiguration,
        appModel: AppModel
    ) async {
        await services.configurationStore.save(configuration)
        appModel.serverConfiguration = configuration
        appModel.runtimeMode = configuration.runtimeMode
        appModel.connectionState = .connecting
        await refresh(appModel: appModel)
    }

    public func setLaunchAtLogin(_ enabled: Bool, appModel: AppModel) async {
        do {
            try await services.loginItem.setEnabled(enabled)
            appModel.launchAtLoginEnabled = enabled
        } catch {
            appModel.statusMessage = "Não foi possível atualizar abertura automática."
        }
    }

    public func promoteCurrentMac(appModel: AppModel) async {
        do {
            appModel.connectionState = .connecting
            appModel.connectionState = try await services.primaryNode.promoteCurrentMac()
            appModel.statusMessage = "Este Mac assumiu a coordenação da rede local."
        } catch {
            appModel.connectionState = .degraded(message: "Promoção manual falhou.")
            appModel.statusMessage = error.localizedDescription
        }
    }

    public func loadIssueDetail(issueID: String, appModel: AppModel) async throws -> IssueConsoleDetail {
        try await services.console.loadIssueDetail(
            configuration: appModel.serverConfiguration,
            issueID: issueID
        )
    }

    public func loadAgentDetail(agentID: String, appModel: AppModel) async throws -> AgentConsoleDetail {
        try await services.console.loadAgentDetail(
            configuration: appModel.serverConfiguration,
            agentID: agentID
        )
    }

    public func loadApprovalDetail(approvalID: String, appModel: AppModel) async throws -> ApprovalDetail {
        try await services.console.loadApprovalDetail(
            configuration: appModel.serverConfiguration,
            approvalID: approvalID
        )
    }

    public func addApprovalComment(
        approvalID: String,
        body: String,
        appModel: AppModel
    ) async throws -> ApprovalDetail {
        _ = try await services.console.addApprovalComment(
            configuration: appModel.serverConfiguration,
            approvalID: approvalID,
            body: body
        )
        let detail = try await loadApprovalDetail(approvalID: approvalID, appModel: appModel)
        await refresh(appModel: appModel)
        appModel.statusMessage = "Comentário adicionado à aprovação."
        return detail
    }

    public func performApprovalAction(
        approvalID: String,
        action: ApprovalDecisionAction,
        note: String?,
        appModel: AppModel
    ) async throws -> ApprovalDetail {
        let detail = try await services.console.performApprovalAction(
            configuration: appModel.serverConfiguration,
            approvalID: approvalID,
            action: action,
            note: note
        )
        await refresh(appModel: appModel)
        appModel.statusMessage = "Aprovação atualizada com ação \(action.label.lowercased())."
        return detail
    }

    public func loadPluginConsoleSnapshot(
        pluginID: String,
        logLimit: Int,
        appModel: AppModel
    ) async throws -> PluginConsoleSnapshot {
        try await services.console.loadPluginConsoleSnapshot(
            configuration: appModel.serverConfiguration,
            pluginID: pluginID,
            logLimit: logLimit
        )
    }

    public func setPluginEnabled(
        pluginID: String,
        isEnabled: Bool,
        reason: String?,
        appModel: AppModel
    ) async throws -> PluginConsoleSnapshot {
        _ = try await services.console.setPluginEnabled(
            configuration: appModel.serverConfiguration,
            pluginID: pluginID,
            isEnabled: isEnabled,
            reason: reason
        )
        await refresh(appModel: appModel)
        appModel.statusMessage = isEnabled ? "Plugin habilitado." : "Plugin desabilitado."
        return try await loadPluginConsoleSnapshot(pluginID: pluginID, logLimit: 40, appModel: appModel)
    }

    public func upgradePlugin(
        pluginID: String,
        targetVersion: String?,
        appModel: AppModel
    ) async throws -> PluginConsoleSnapshot {
        _ = try await services.console.upgradePlugin(
            configuration: appModel.serverConfiguration,
            pluginID: pluginID,
            targetVersion: targetVersion
        )
        await refresh(appModel: appModel)
        appModel.statusMessage = "Upgrade do plugin solicitado."
        return try await loadPluginConsoleSnapshot(pluginID: pluginID, logLimit: 40, appModel: appModel)
    }

    public func loadProjectWorkspaces(
        projectID: String,
        appModel: AppModel
    ) async throws -> [ProjectWorkspaceDetail] {
        try await services.console.loadProjectWorkspaces(
            configuration: appModel.serverConfiguration,
            projectID: projectID
        )
    }

    public func performWorkspaceRuntimeAction(
        projectID: String,
        workspaceID: String,
        action: WorkspaceRuntimeAction,
        appModel: AppModel
    ) async throws -> WorkspaceRuntimeActionResult {
        let result = try await services.console.performWorkspaceRuntimeAction(
            configuration: appModel.serverConfiguration,
            projectID: projectID,
            workspaceID: workspaceID,
            action: action
        )
        await refresh(appModel: appModel)
        appModel.statusMessage = "Runtime do workspace atualizado com ação \(action.label.lowercased())."
        return result
    }

    private func applySnapshot(appModel: AppModel, connectionState: ConnectionState) async {
        do {
            let snapshot = try await services.operations.loadSnapshot(
                configuration: appModel.serverConfiguration,
                selectedCompanyID: appModel.selectedCompanyID
            )
            appModel.apply(snapshot: snapshot, connectionState: connectionState)
            if snapshot.companies.isEmpty {
                appModel.statusMessage = "Nenhuma empresa encontrada nessa instância."
            }
        } catch {
            appModel.connectionState = .degraded(message: "Falha ao carregar a operação inicial.")
            appModel.isBootstrapping = false
            appModel.statusMessage = error.localizedDescription
        }
    }
}
