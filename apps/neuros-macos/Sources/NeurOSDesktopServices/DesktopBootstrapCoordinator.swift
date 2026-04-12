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
        appModel.localServerStatus = await services.localServer.currentStatus(configuration: configuration)
        await services.notifications.requestAuthorizationIfNeeded()

        let peers = await services.localNetwork.discoverPeers()
        if peers.isEmpty == false {
            appModel.statusMessage = "Rede local pronta com \(peers.count) nós detectados."
        }

        await refresh(appModel: appModel)
    }

    public func refresh(appModel: AppModel) async {
        await syncLocalServerStatus(
            configuration: appModel.serverConfiguration,
            autoStartIfNeeded: false,
            appModel: appModel
        )
        var connectionState = await resolveConnectionState(
            configuration: appModel.serverConfiguration,
            appModel: appModel
        )

        if connectionState.isConnected == false {
            await syncLocalServerStatus(
                configuration: appModel.serverConfiguration,
                autoStartIfNeeded: true,
                appModel: appModel
            )
            connectionState = await resolveConnectionState(
                configuration: appModel.serverConfiguration,
                appModel: appModel
            )
        }

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
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        return try await services.console.loadIssueDetail(
            configuration: appModel.serverConfiguration,
            issueID: issueID,
            companyId: companyId
        )
    }

    public func loadAgentDetail(agentID: String, appModel: AppModel) async throws -> AgentConsoleDetail {
        try await services.console.loadAgentDetail(
            configuration: appModel.serverConfiguration,
            agentID: agentID
        )
    }

    public func loadApprovalDetail(approvalID: String, appModel: AppModel) async throws -> ApprovalDetail {
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        return try await services.console.loadApprovalDetail(
            configuration: appModel.serverConfiguration,
            approvalID: approvalID,
            companyId: companyId
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
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        let detail = try await services.console.performApprovalAction(
            configuration: appModel.serverConfiguration,
            approvalID: approvalID,
            action: action,
            note: note,
            companyId: companyId
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

    public func startLocalServer(appModel: AppModel) async {
        do {
            appModel.localServerStatus = try await services.localServer.start(configuration: appModel.serverConfiguration)
            appModel.statusMessage = "Inicializando servidor local do Paperclip."
            await refresh(appModel: appModel)
        } catch {
            appModel.localServerStatus = await services.localServer.currentStatus(configuration: appModel.serverConfiguration)
            appModel.statusMessage = error.localizedDescription
        }
    }

    public func restartLocalServer(appModel: AppModel) async {
        do {
            appModel.localServerStatus = try await services.localServer.restart(configuration: appModel.serverConfiguration)
            appModel.statusMessage = "Reiniciando servidor local do Paperclip."
            await refresh(appModel: appModel)
        } catch {
            appModel.localServerStatus = await services.localServer.currentStatus(configuration: appModel.serverConfiguration)
            appModel.statusMessage = error.localizedDescription
        }
    }

    public func stopLocalServer(appModel: AppModel) async {
        appModel.localServerStatus = await services.localServer.stop()
        appModel.connectionState = .degraded(message: "Servidor local parado pelo app.")
        appModel.statusMessage = "Servidor local parado. A API local ficará indisponível até uma nova inicialização."
        appModel.health = nil
    }

    public func updateGeneralSettings(
        _ settings: InstanceGeneralSettingsSummary,
        appModel: AppModel
    ) async {
        do {
            let general = try await services.instanceSettings.updateGeneralSettings(
                configuration: appModel.serverConfiguration,
                settings: settings
            )
            let current = appModel.instanceSettings ?? .default
            appModel.applyInstanceSettings(
                InstanceSettingsSnapshot(general: general, experimental: current.experimental)
            )
            appModel.statusMessage = "Configurações gerais atualizadas."
        } catch {
            appModel.statusMessage = error.localizedDescription
        }
    }

    public func updateExperimentalSettings(
        _ settings: InstanceExperimentalSettingsSummary,
        appModel: AppModel
    ) async {
        do {
            let experimental = try await services.instanceSettings.updateExperimentalSettings(
                configuration: appModel.serverConfiguration,
                settings: settings
            )
            let current = appModel.instanceSettings ?? .default
            appModel.applyInstanceSettings(
                InstanceSettingsSnapshot(general: current.general, experimental: experimental)
            )
            appModel.statusMessage = "Configurações experimentais atualizadas."
            await refresh(appModel: appModel)
        } catch {
            appModel.statusMessage = error.localizedDescription
        }
    }

    private func applySnapshot(appModel: AppModel, connectionState: ConnectionState) async {
        do {
            let snapshot = try await services.operations.loadSnapshot(
                configuration: appModel.serverConfiguration,
                selectedCompanyID: appModel.selectedCompanyID
            )
            appModel.apply(snapshot: snapshot, connectionState: connectionState)
            await loadInstanceSettings(appModel: appModel)
            if snapshot.companies.isEmpty {
                appModel.statusMessage = "Nenhuma empresa encontrada nessa instância."
            }
        } catch {
            appModel.connectionState = .degraded(message: "Falha ao carregar a operação inicial.")
            appModel.isBootstrapping = false
            appModel.statusMessage = error.localizedDescription
        }
    }

    private func loadInstanceSettings(appModel: AppModel) async {
        do {
            let settings = try await services.instanceSettings.loadInstanceSettings(
                configuration: appModel.serverConfiguration
            )
            appModel.applyInstanceSettings(settings)
        } catch {
            if appModel.instanceSettings == nil {
                appModel.statusMessage = "Falha ao carregar configurações da instância."
            }
        }
    }

    private func resolveConnectionState(
        configuration: ServerConnectionConfiguration,
        appModel: AppModel
    ) async -> ConnectionState {
        var connectionState = await services.connection.currentConnectionState(configuration: configuration)

        if shouldManageLocalServer(configuration),
           connectionState.isConnected == false,
           appModel.localServerStatus.phase == .starting {
            for _ in 0..<12 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                connectionState = await services.connection.currentConnectionState(configuration: configuration)
                if connectionState.isConnected {
                    break
                }
            }
        }

        if connectionState.isConnected {
            await services.localServer.noteAPIReachable()
            appModel.localServerStatus = await services.localServer.currentStatus(configuration: configuration)
        }

        return connectionState
    }

    private func syncLocalServerStatus(
        configuration: ServerConnectionConfiguration,
        autoStartIfNeeded: Bool,
        appModel: AppModel
    ) async {
        guard shouldManageLocalServer(configuration) else {
            appModel.localServerStatus = await services.localServer.currentStatus(configuration: configuration)
            return
        }

        do {
            if autoStartIfNeeded && shouldAutoStartLocalServer(configuration) {
                appModel.localServerStatus = try await services.localServer.ensureRunning(configuration: configuration)
            } else {
                appModel.localServerStatus = await services.localServer.currentStatus(configuration: configuration)
            }
        } catch {
            appModel.localServerStatus = await services.localServer.currentStatus(configuration: configuration)
            appModel.statusMessage = error.localizedDescription
        }
    }

    private func shouldManageLocalServer(_ configuration: ServerConnectionConfiguration) -> Bool {
        configuration.canManageLocalServer && configuration.runtimeMode != .remote
    }

    private func shouldAutoStartLocalServer(_ configuration: ServerConnectionConfiguration) -> Bool {
        shouldManageLocalServer(configuration) && configuration.localServer.autoStartOnLaunch
    }

    // MARK: - Extended feature methods

    public func listRoutines(appModel: AppModel) async throws -> [RoutineSummary] {
        guard let companyId = appModel.selectedCompanyID else { return [] }
        return try await services.console.listRoutines(configuration: appModel.serverConfiguration, companyId: companyId)
    }

    public func loadRoutineDetail(routineId: String, appModel: AppModel) async throws -> RoutineDetail {
        return try await services.console.loadRoutineDetail(configuration: appModel.serverConfiguration, routineId: routineId)
    }

    public func triggerRoutineRun(routineId: String, appModel: AppModel) async throws -> RoutineDetail {
        let detail = try await services.console.triggerRoutineRun(configuration: appModel.serverConfiguration, routineId: routineId)
        await refresh(appModel: appModel)
        return detail
    }

    public func loadCostSummary(appModel: AppModel) async throws -> CostSummarySnapshot {
        guard let companyId = appModel.selectedCompanyID else {
            return CostSummarySnapshot(totalCostCents: 0, eventCount: 0, agentCount: 0, modelCount: 0, providerCount: 0)
        }
        return try await services.console.loadCostSummary(configuration: appModel.serverConfiguration, companyId: companyId)
    }

    public func loadCostBreakdown(appModel: AppModel) async throws -> [CostBreakdownEntry] {
        guard let companyId = appModel.selectedCompanyID else { return [] }
        return try await services.console.loadCostBreakdownByAgent(configuration: appModel.serverConfiguration, companyId: companyId)
    }

    public func listAdapters(appModel: AppModel) async throws -> [AdapterSummary] {
        return try await services.console.listAdapters(configuration: appModel.serverConfiguration)
    }

    public func toggleAdapterDisabled(type: String, disabled: Bool, appModel: AppModel) async throws -> [AdapterSummary] {
        return try await services.console.toggleAdapterDisabled(configuration: appModel.serverConfiguration, type: type, disabled: disabled)
    }

    public func installAdapter(packageName: String, isLocalPath: Bool, version: String?, appModel: AppModel) async throws -> [AdapterSummary] {
        try await services.console.installAdapter(
            configuration: appModel.serverConfiguration,
            packageName: packageName,
            isLocalPath: isLocalPath,
            version: version
        )
        await refresh(appModel: appModel)
        appModel.statusMessage = "Adapter instalado."
        return try await listAdapters(appModel: appModel)
    }

    public func removeAdapter(type: String, appModel: AppModel) async throws -> [AdapterSummary] {
        try await services.console.removeAdapter(configuration: appModel.serverConfiguration, type: type)
        await refresh(appModel: appModel)
        appModel.statusMessage = "Adapter removido."
        return try await listAdapters(appModel: appModel)
    }

    public func listCompanySkills(appModel: AppModel) async throws -> [CompanySkillSummary] {
        guard let companyId = appModel.selectedCompanyID else { return [] }
        return try await services.console.listCompanySkills(configuration: appModel.serverConfiguration, companyId: companyId)
    }

    public func loadOrgTree(appModel: AppModel) async throws -> [OrgNode] {
        guard let companyId = appModel.selectedCompanyID else { return [] }
        return try await services.console.loadOrgTree(configuration: appModel.serverConfiguration, companyId: companyId)
    }

    public func loadCompanySettings(appModel: AppModel) async throws -> CompanySettingsDetail {
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        return try await services.console.loadCompanySettings(configuration: appModel.serverConfiguration, companyId: companyId)
    }

    public func updateCompanySettings(_ settings: CompanySettingsDraft, appModel: AppModel) async throws -> CompanySettingsDetail {
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        let detail = try await services.console.updateCompanySettings(
            configuration: appModel.serverConfiguration,
            companyId: companyId,
            settings: settings
        )
        await refresh(appModel: appModel)
        appModel.statusMessage = "Configurações da empresa atualizadas."
        return detail
    }

    public func createIssue(title: String, description: String?, priority: String?, assigneeAgentId: String?, projectId: String?, goalId: String?, appModel: AppModel) async throws -> IssueQueueSummary {
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        let issue = try await services.console.createIssue(
            configuration: appModel.serverConfiguration, companyId: companyId,
            title: title, description: description, priority: priority,
            assigneeAgentId: assigneeAgentId, projectId: projectId, goalId: goalId
        )
        await refresh(appModel: appModel)
        return issue
    }

    public func createAgent(name: String, role: String?, adapterType: String, reportsTo: String?, appModel: AppModel) async throws {
        guard let companyId = appModel.selectedCompanyID else {
            throw NSError(domain: "io.goldneuron.neurOS", code: -1, userInfo: [NSLocalizedDescriptionKey: "Nenhuma empresa selecionada."])
        }
        try await services.console.createAgent(
            configuration: appModel.serverConfiguration, companyId: companyId,
            name: name, role: role, adapterType: adapterType, reportsTo: reportsTo
        )
        await refresh(appModel: appModel)
    }
}
