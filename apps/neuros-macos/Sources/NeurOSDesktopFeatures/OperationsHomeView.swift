import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct OperationsHomeView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SectionHeroView(
                    title: "Central Operacional",
                    subtitle: "Resumo executivo da instância conectada, com foco na empresa ativa, orçamento, fila operacional e sinais de runtime."
                ) {
                    HStack(spacing: 10) {
                        if appModel.serverConfiguration.canManageLocalServer {
                            Button {
                                Task { await coordinator.startLocalServer(appModel: appModel) }
                            } label: {
                                Label("Iniciar backend", systemImage: "play.fill")
                            }
                            .buttonStyle(.bordered)
                            .disabled(appModel.localServerStatus.phase == .running || appModel.localServerStatus.phase == .starting)

                            Button {
                                Task { await coordinator.restartLocalServer(appModel: appModel) }
                            } label: {
                                Label("Reiniciar backend", systemImage: "arrow.triangle.2.circlepath")
                            }
                            .buttonStyle(.bordered)
                            .disabled(appModel.localServerStatus.isManagedProcess == false)
                        }

                        Button {
                            Task { await coordinator.refresh(appModel: appModel) }
                        } label: {
                            Label("Atualizar", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }

                OperationsHeroView(appModel: appModel)
                ConnectionHealthView(appModel: appModel, coordinator: coordinator)
                OperationalAttentionView(appModel: appModel, coordinator: coordinator)
                DashboardMetricsGrid(appModel: appModel)

                HStack(alignment: .top, spacing: 20) {
                    RuntimeSummaryView(appModel: appModel)
                    ApprovalsQueueView(appModel: appModel)
                }

                HStack(alignment: .top, spacing: 20) {
                    QueuePreviewView(appModel: appModel)
                    ProjectsPreviewView(appModel: appModel)
                }

                ActiveAgentsView(appModel: appModel)
            }
            .padding(28)
        }
        .navigationTitle("Central Operacional")
        .background(
            LinearGradient(
                colors: [Color.blue.opacity(0.05), Color.cyan.opacity(0.03), .clear],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }
}

private struct OperationalAttentionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    private enum AttentionState {
        case localServerFailed(detail: String)
        case devServerRestart(DevServerStatusSummary)
        case degraded(message: String)
        case disconnected
        case stable
    }

    private var state: AttentionState {
        if appModel.localServerStatus.phase == .failed {
            return .localServerFailed(detail: appModel.localServerStatus.detail)
        }

        if let devServer = appModel.health?.devServer, devServer.restartRequired {
            return .devServerRestart(devServer)
        }

        switch appModel.connectionState {
        case let .degraded(message):
            return .degraded(message: message)
        case .disconnected:
            return .disconnected
        case .connecting, .local, .remote:
            return .stable
        }
    }

    private var accent: Color {
        switch state {
        case .localServerFailed:
            .red
        case .devServerRestart:
            .orange
        case .degraded, .disconnected:
            .orange
        case .stable:
            .green
        }
    }

    private var pillLabel: String {
        switch state {
        case .localServerFailed:
            "ação necessária"
        case .devServerRestart:
            "restart pendente"
        case .degraded:
            "instável"
        case .disconnected:
            "offline"
        case .stable:
            "estável"
        }
    }

    private var title: String {
        switch state {
        case .localServerFailed:
            "Backend local exige intervenção"
        case .devServerRestart:
            "Dev server precisa reiniciar"
        case .degraded:
            "Conexão degradada"
        case .disconnected:
            "API indisponível"
        case .stable:
            "Operação dentro do esperado"
        }
    }

    private var detail: String {
        switch state {
        case let .localServerFailed(detail):
            detail
        case let .devServerRestart(devServer):
            devServer.reason ?? "Há mudanças pendentes no ambiente e o servidor precisa reciclar para refletir o novo estado."
        case let .degraded(message):
            message
        case .disconnected:
            "A instância não respondeu ao último ciclo de refresh. Verifique a URL configurada e o backend local."
        case .stable:
            "A API está respondendo, a instância ativa foi carregada e os controles operacionais estão prontos para uso."
        }
    }

    private var footnote: String? {
        switch state {
        case let .devServerRestart(devServer):
            let pathInfo = devServer.changedPathCount > 0 ? "\(devServer.changedPathCount) arquivo(s) alterado(s)" : nil
            let migrationInfo = devServer.pendingMigrations.isEmpty ? nil : "migrations pendentes: \(devServer.pendingMigrations.joined(separator: ", "))"
            let idleInfo = devServer.waitingForIdle ? "aguardando janela ociosa" : nil
            return [pathInfo, migrationInfo, idleInfo].compactMap { $0 }.joined(separator: " · ")
        case .localServerFailed:
            if let exitCode = appModel.localServerStatus.lastExitCode {
                return "Último encerramento com código \(exitCode)."
            }
            return nil
        case .degraded, .disconnected:
            return appModel.statusMessage
        case .stable:
            return "Modo \(appModel.runtimeMode.rawValue) · backend local \(appModel.localServerStatus.label.lowercased())"
        }
    }

    var body: some View {
        SurfaceCard {
            HStack(alignment: .top, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Text(title)
                            .font(.headline)
                        StatusPill(label: pillLabel, color: accent)
                    }

                    Text(detail)
                        .foregroundStyle(.secondary)

                    if let footnote, footnote.isEmpty == false {
                        Text(footnote)
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 10) {
                    primaryAction
                    Button("Atualizar") {
                        Task { await coordinator.refresh(appModel: appModel) }
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    @ViewBuilder
    private var primaryAction: some View {
        switch state {
        case .localServerFailed, .devServerRestart:
            if appModel.serverConfiguration.canManageLocalServer {
                Button("Reiniciar backend") {
                    Task { await coordinator.restartLocalServer(appModel: appModel) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(appModel.localServerStatus.isManagedProcess == false)
            }
        case .degraded, .disconnected, .stable:
            if appModel.serverConfiguration.canManageLocalServer,
               appModel.localServerStatus.phase != .running,
               appModel.localServerStatus.phase != .starting {
                Button("Iniciar backend") {
                    Task { await coordinator.startLocalServer(appModel: appModel) }
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

private struct ConnectionHealthView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    var body: some View {
        SurfaceCard {
            Text("Operação híbrida")
                .font(.headline)

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(appModel.connectionState.label)
                        .font(.title3.weight(.semibold))
                    Text(appModel.statusMessage ?? "A instância macOS acompanha a API real do Paperclip e pode alternar entre topologia local e remota.")
                        .foregroundStyle(.secondary)
                    if let health = appModel.health {
                        Text("Servidor \(health.status) em \(health.deploymentMode ?? "unknown")/\(health.deploymentExposure ?? "unknown")")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text(appModel.selectedCompanyName)
                        .font(.headline)
                    Text(appModel.selectedCompanyStatus.uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor(for: appModel.selectedCompanyStatus))
                }
            }

            HStack {
                Label("Modo \(appModel.runtimeMode.rawValue)", systemImage: "network")
                    .foregroundStyle(.secondary)
                Spacer()
                if appModel.serverConfiguration.canManageLocalServer {
                    Button("Iniciar backend") {
                        Task { await coordinator.startLocalServer(appModel: appModel) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(appModel.localServerStatus.phase == .running || appModel.localServerStatus.phase == .starting)

                    Button("Reiniciar backend") {
                        Task { await coordinator.restartLocalServer(appModel: appModel) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(appModel.localServerStatus.isManagedProcess == false)
                }
                Button("Assumir coordenação") {
                    Task { await coordinator.promoteCurrentMac(appModel: appModel) }
                }
                .buttonStyle(.bordered)
            }

            if appModel.serverConfiguration.canManageLocalServer {
                Divider()
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Backend local: \(appModel.localServerStatus.label)")
                            .font(.subheadline.weight(.medium))
                        Text(appModel.localServerStatus.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let pid = appModel.localServerStatus.pid {
                        Text("PID \(pid)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }
}
