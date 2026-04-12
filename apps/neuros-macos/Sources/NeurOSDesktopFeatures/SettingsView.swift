import AppKit
import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct SettingsView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    @State private var draftBaseURL: String
    @State private var draftRuntimeMode: RuntimeMode
    @State private var draftAutoStartOnLaunch: Bool
    @State private var draftWorkspaceRootPath: String
    @State private var draftCustomCommand: String
    private let cardColumns = [GridItem(.adaptive(minimum: 360), spacing: 20)]

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
        _draftBaseURL = State(initialValue: appModel.serverConfiguration.baseURLString)
        _draftRuntimeMode = State(initialValue: appModel.serverConfiguration.runtimeMode)
        _draftAutoStartOnLaunch = State(initialValue: appModel.serverConfiguration.localServer.autoStartOnLaunch)
        _draftWorkspaceRootPath = State(initialValue: appModel.serverConfiguration.localServer.workspaceRootPath)
        _draftCustomCommand = State(initialValue: appModel.serverConfiguration.localServer.customCommand)
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                settingsHero
                settingsMetrics

                LazyVGrid(columns: cardColumns, alignment: .leading, spacing: 20) {
                    applicationCard
                    connectionCard
                    localServerCard
                    instanceSettingsCard
                    desktopCard
                    diagnosticsCard
                }
            }
            .padding(20)
        }
        .navigationTitle("Configurações")
        .background(GoldNeuronSceneBackground())
        .onAppear {
            syncDrafts(from: appModel.serverConfiguration)
        }
        .onChange(of: appModel.serverConfiguration) { _, configuration in
            syncDrafts(from: configuration)
        }
    }

    private var settingsHero: some View {
        SectionHeroView(
            title: "Controle da instância",
            subtitle: "Conexão e backend local."
        ) {
            HStack(spacing: 10) {
                Button("Salvar") {
                    Task { await saveConfiguration() }
                }
                .buttonStyle(.borderedProminent)

                Button("Atualizar") {
                    Task { await coordinator.refresh(appModel: appModel) }
                }
                .buttonStyle(.bordered)

                if draftConfiguration.canManageLocalServer {
                    Button("Iniciar backend") {
                        Task { await saveAndStartLocalServer() }
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private var settingsMetrics: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 16)], spacing: 16) {
            MetricTile(title: "API", value: appModel.health?.status.uppercased() ?? "OFFLINE", accent: healthAccent)
            MetricTile(title: "Conexão", value: connectionMetricLabel, accent: connectionAccent)
            MetricTile(title: "Backend local", value: appModel.localServerStatus.label, accent: localServerAccent)
            MetricTile(title: "Bootstrap", value: bootstrapMetricLabel, accent: bootstrapAccent)
        }
    }

    private var applicationCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Aplicação")
                    .font(.headline)
                LabeledContent("Produto", value: appModel.identity.productName)
                LabeledContent("Versão", value: appModel.identity.version)
                LabeledContent("Bundle", value: appModel.identity.bundleIdentifier)
            }
        }
    }

    private var connectionCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Conectividade")
                            .font(.headline)
                    }
                    Spacer()
                    StatusPill(label: draftRuntimeMode.rawValue, color: .blue)
                    if hasUnsavedChanges {
                        StatusPill(label: "unsaved", color: .orange)
                    }
                }

                TextField("http://127.0.0.1:3100", text: $draftBaseURL)
                    .textFieldStyle(.roundedBorder)

                Picker("Runtime preferido", selection: $draftRuntimeMode) {
                    Text("Híbrido").tag(RuntimeMode.hybrid)
                    Text("Local").tag(RuntimeMode.local)
                    Text("Remoto").tag(RuntimeMode.remote)
                }
                .pickerStyle(.segmented)

                LabeledContent("API normalizada", value: normalizedAPIValue)
                if let resolvedHost = draftConfiguration.resolvedHost {
                    LabeledContent("Host resolvido", value: resolvedHost)
                }
                LabeledContent("Estado atual", value: appModel.connectionState.label)

                Text(connectionHint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                HStack {
                    Button("Salvar e reconectar") {
                        Task { await saveConfiguration() }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Atualizar agora") {
                        Task { await coordinator.refresh(appModel: appModel) }
                    }
                    .buttonStyle(.bordered)

                    if hasUnsavedChanges {
                        Text("Há mudanças não salvas.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var localServerCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Servidor local")
                            .font(.headline)
                        Text("Bootstrap, restart e diagnóstico do backend local do Paperclip a partir do app.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(label: appModel.localServerStatus.label, color: localServerAccent)
                }

                Toggle("Iniciar automaticamente quando o app abrir", isOn: $draftAutoStartOnLaunch)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Workspace Paperclip")
                        .font(.subheadline.weight(.medium))
                    HStack {
                        TextField("/Users/monrars/paperclip", text: $draftWorkspaceRootPath)
                            .textFieldStyle(.roundedBorder)
                        Button("Escolher pasta…") {
                            pickWorkspaceRoot()
                        }
                        .buttonStyle(.bordered)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Comando customizado")
                        .font(.subheadline.weight(.medium))
                    TextField("Automático (recomendado)", text: $draftCustomCommand)
                        .textFieldStyle(.roundedBorder)
                    Text("Se vazio, o app resolve automaticamente o melhor launcher: `pnpm paperclipai run`, depois `node cli/src/index.ts run`, e só cai para `paperclipai run` quando estiver fora do workspace.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if draftConfiguration.canManageLocalServer == false {
                    Text("O gerenciamento embutido só fica ativo quando a URL aponta para `localhost`, `127.0.0.1` ou `::1`, com runtime local ou híbrido.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Divider()

                LabeledContent("Fase", value: appModel.localServerStatus.label)
                if let resolvedCommand = appModel.localServerStatus.resolvedCommand {
                    LabeledContent("Comando resolvido", value: resolvedCommand)
                }
                if let resolvedWorkingDirectory = appModel.localServerStatus.resolvedWorkingDirectory {
                    LabeledContent("Diretório", value: resolvedWorkingDirectory)
                }
                LabeledContent("Detalhe", value: appModel.localServerStatus.detail)
                if let pid = appModel.localServerStatus.pid {
                    LabeledContent("PID", value: String(pid))
                }

                HStack {
                    Button("Salvar e iniciar") {
                        Task { await saveAndStartLocalServer() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(draftConfiguration.canManageLocalServer == false)

                    Button("Salvar e reiniciar") {
                        Task { await saveAndRestartLocalServer() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(draftConfiguration.canManageLocalServer == false)

                    Button("Parar") {
                        Task { await coordinator.stopLocalServer(appModel: appModel) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(appModel.localServerStatus.isManagedProcess == false)
                }

                if appModel.localServerStatus.recentOutput.isEmpty == false {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Saída recente")
                            .font(.subheadline.weight(.medium))
                        ScrollView {
                            Text(appModel.localServerStatus.recentOutput.joined(separator: "\n"))
                                .font(.system(.caption, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                                .padding(10)
                        }
                        .frame(minHeight: 120, maxHeight: 180)
                        .background(GoldNeuronBrand.surfaceRaised.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
        }
    }

    private var instanceSettingsCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Preferências da instância")
                            .font(.headline)
                    }
                    Spacer()
                    StatusPill(label: appModel.instanceSettings == nil ? "loading" : "ready", color: appModel.instanceSettings == nil ? .orange : .green)
                }

                if let settings = appModel.instanceSettings {
                    Toggle(
                        "Ocultar nome de usuário em logs e caminhos locais",
                        isOn: Binding(
                            get: { settings.general.censorUsernameInLogs },
                            set: { newValue in
                                var next = settings.general
                                next.censorUsernameInLogs = newValue
                                Task { await coordinator.updateGeneralSettings(next, appModel: appModel) }
                            }
                        )
                    )

                    Toggle(
                        "Ativar atalhos de teclado operacionais",
                        isOn: Binding(
                            get: { settings.general.keyboardShortcuts },
                            set: { newValue in
                                var next = settings.general
                                next.keyboardShortcuts = newValue
                                Task { await coordinator.updateGeneralSettings(next, appModel: appModel) }
                            }
                        )
                    )

                    Picker(
                        "Compartilhamento de feedback",
                        selection: Binding(
                            get: { settings.general.feedbackDataSharingPreference },
                            set: { newValue in
                                var next = settings.general
                                next.feedbackDataSharingPreference = newValue
                                Task { await coordinator.updateGeneralSettings(next, appModel: appModel) }
                            }
                        )
                    ) {
                        Text("Perguntar").tag("prompt")
                        Text("Permitir").tag("allowed")
                        Text("Não permitir").tag("not_allowed")
                    }

                    Divider()

                    Toggle(
                        "Habilitar workspaces isolados",
                        isOn: Binding(
                            get: { settings.experimental.enableIsolatedWorkspaces },
                            set: { newValue in
                                var next = settings.experimental
                                next.enableIsolatedWorkspaces = newValue
                                Task { await coordinator.updateExperimentalSettings(next, appModel: appModel) }
                            }
                        )
                    )

                    Toggle(
                        "Reiniciar dev server automaticamente quando ficar ocioso",
                        isOn: Binding(
                            get: { settings.experimental.autoRestartDevServerWhenIdle },
                            set: { newValue in
                                var next = settings.experimental
                                next.autoRestartDevServerWhenIdle = newValue
                                Task { await coordinator.updateExperimentalSettings(next, appModel: appModel) }
                            }
                        )
                    )
                } else {
                    EmptyCollectionState(message: "Configurações ainda não carregadas.")
                }
            }
        }
    }

    private var desktopCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Desktop")
                    .font(.headline)
                Toggle("Abrir ao iniciar sessão", isOn: Binding(
                    get: { appModel.launchAtLoginEnabled },
                    set: { enabled in
                        Task { await coordinator.setLaunchAtLogin(enabled, appModel: appModel) }
                    }
                ))

                Toggle("Notificações operacionais", isOn: Binding(
                    get: { appModel.notificationsEnabled },
                    set: { appModel.notificationsEnabled = $0 }
                ))
            }
        }
    }

    private var diagnosticsCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Diagnóstico")
                            .font(.headline)
                    }
                    Spacer()
                    if let health = appModel.health {
                        StatusPill(label: health.status, color: healthAccent)
                    }
                }

                if let health = appModel.health {
                    LabeledContent("Servidor", value: health.status)
                    LabeledContent("Versão API", value: health.version)
                    LabeledContent(
                        "Deployment",
                        value: "\(health.deploymentMode ?? "unknown") / \(health.deploymentExposure ?? "unknown")"
                    )
                    LabeledContent("Auth pronta", value: yesNoLabel(health.authReady))
                    LabeledContent("Bootstrap", value: health.bootstrapStatus ?? "unknown")
                    LabeledContent("Convite bootstrap ativo", value: yesNoLabel(health.bootstrapInviteActive))

                    if let devServer = health.devServer {
                        Divider()
                        LabeledContent("Dev server exige restart", value: devServer.restartRequired ? "Sim" : "Não")
                        LabeledContent("Motivo", value: devServer.reason ?? "Sem motivo registrado")
                        LabeledContent("Aguardando idle", value: devServer.waitingForIdle ? "Sim" : "Não")
                        LabeledContent("Execuções ativas", value: String(devServer.activeRunCount))
                        if devServer.pendingMigrations.isEmpty == false {
                            LabeledContent("Migrations pendentes", value: devServer.pendingMigrations.joined(separator: ", "))
                        }
                    }
                } else {
                    Text("Sem resposta de health check no momento.")
                        .foregroundStyle(.secondary)
                }

                if let lastRefreshedAt = appModel.lastRefreshedAt {
                    LabeledContent("Última atualização", value: Self.timestampFormatter.string(from: lastRefreshedAt))
                }

                if let statusMessage = appModel.statusMessage {
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var draftConfiguration: ServerConnectionConfiguration {
        ServerConnectionConfiguration(
            baseURLString: draftBaseURL,
            runtimeMode: draftRuntimeMode,
            localServer: LocalServerLaunchConfiguration(
                autoStartOnLaunch: draftAutoStartOnLaunch,
                workspaceRootPath: draftWorkspaceRootPath,
                customCommand: draftCustomCommand
            )
        )
    }

    private var normalizedAPIValue: String {
        draftConfiguration.apiBaseURL?.absoluteString ?? "URL inválida"
    }

    private var hasUnsavedChanges: Bool {
        draftConfiguration != appModel.serverConfiguration
    }

    private var connectionHint: String {
        if draftConfiguration.canManageLocalServer {
            return "Esta configuração permite que o app gerencie o backend local do Paperclip."
        }
        return "Use uma URL local para que o app consiga iniciar e monitorar o backend automaticamente."
    }

    private var connectionMetricLabel: String {
        switch appModel.connectionState {
        case .local:
            "Local"
        case .remote:
            "Remota"
        case .connecting:
            "Conectando"
        case .disconnected:
            "Offline"
        case .degraded:
            "Atenção"
        }
    }

    private var connectionAccent: Color {
        switch appModel.connectionState {
        case .local:
            .green
        case .remote:
            .blue
        case .connecting:
            .cyan
        case .disconnected, .degraded:
            .orange
        }
    }

    private var localServerAccent: Color {
        switch appModel.localServerStatus.phase {
        case .idle:
            .orange
        case .starting:
            .blue
        case .running:
            .green
        case .failed:
            .red
        }
    }

    private var healthAccent: Color {
        statusColor(for: appModel.health?.status ?? "unknown")
    }

    private var bootstrapMetricLabel: String {
        humanizeOperationalLabel(appModel.health?.bootstrapStatus ?? "unknown")
    }

    private var bootstrapAccent: Color {
        statusColor(for: appModel.health?.bootstrapStatus ?? "unknown")
    }

    private func saveConfiguration() async {
        await coordinator.updateServerConfiguration(draftConfiguration, appModel: appModel)
    }

    private func saveAndStartLocalServer() async {
        await saveConfiguration()
        await coordinator.startLocalServer(appModel: appModel)
    }

    private func saveAndRestartLocalServer() async {
        await saveConfiguration()
        await coordinator.restartLocalServer(appModel: appModel)
    }

    private func syncDrafts(from configuration: ServerConnectionConfiguration) {
        draftBaseURL = configuration.baseURLString
        draftRuntimeMode = configuration.runtimeMode
        draftAutoStartOnLaunch = configuration.localServer.autoStartOnLaunch
        draftWorkspaceRootPath = configuration.localServer.workspaceRootPath
        draftCustomCommand = configuration.localServer.customCommand
    }

    private func pickWorkspaceRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Selecionar"
        if panel.runModal() == .OK {
            draftWorkspaceRootPath = panel.url?.path ?? draftWorkspaceRootPath
        }
    }

    private func yesNoLabel(_ value: Bool?) -> String {
        switch value {
        case true: "Sim"
        case false: "Não"
        case nil: "Indisponível"
        }
    }

    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        return formatter
    }()
}
