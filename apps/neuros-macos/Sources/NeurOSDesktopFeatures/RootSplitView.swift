import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct RootSplitView: View {
    @Bindable private var appModel: AppModel
    private let coordinator: DesktopBootstrapCoordinator
    @State private var isShowingCommandPalette = false
    @State private var isShowingNewIssueSheet = false
    @State private var isShowingNewAgentSheet = false

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        NavigationSplitView {
            SidebarNavigationView(appModel: appModel, coordinator: coordinator)
        } detail: {
            Group {
                switch appModel.selectedSection {
                case .operations:
                    OperationsHomeView(appModel: appModel, coordinator: coordinator)
                case .inbox:
                    InboxSectionView(appModel: appModel, coordinator: coordinator)
                case .activity:
                    ActivitySectionView(appModel: appModel, coordinator: coordinator)
                case .goals:
                    GoalsSectionView(appModel: appModel, coordinator: coordinator)
                case .queue:
                    QueueSectionView(appModel: appModel, coordinator: coordinator)
                case .agents:
                    AgentsSectionView(appModel: appModel, coordinator: coordinator)
                case .projects:
                    ProjectsSectionView(appModel: appModel, coordinator: coordinator)
                case .approvals:
                    ApprovalsSectionView(appModel: appModel, coordinator: coordinator)
                case .routines:
                    RoutinesSectionView(appModel: appModel, coordinator: coordinator)
                case .costs:
                    CostsSectionView(appModel: appModel, coordinator: coordinator)
                case .organization:
                    OrganizationSectionView(appModel: appModel, coordinator: coordinator)
                case .skills:
                    SkillsSectionView(appModel: appModel, coordinator: coordinator)
                case .adapters:
                    AdaptersSectionView(appModel: appModel, coordinator: coordinator)
                case .runtime:
                    RuntimeSectionView(appModel: appModel, coordinator: coordinator)
                case .plugins:
                    PluginsSectionView(appModel: appModel, coordinator: coordinator)
                case .settings:
                    SettingsView(appModel: appModel, coordinator: coordinator)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItemGroup {
                Button {
                    isShowingCommandPalette = true
                } label: {
                    Label("Buscar", systemImage: "magnifyingglass")
                }
                .keyboardShortcut("k", modifiers: [.command])

                Button {
                    isShowingNewIssueSheet = true
                } label: {
                    Label("Nova Issue", systemImage: "plus.square.on.square")
                }
                .disabled(appModel.selectedCompanyID == nil)

                Button {
                    isShowingNewAgentSheet = true
                } label: {
                    Label("Novo Agente", systemImage: "person.badge.plus")
                }
                .disabled(appModel.selectedCompanyID == nil)
            }
        }
        .sheet(isPresented: $isShowingCommandPalette) {
            DesktopCommandPalette(
                appModel: appModel,
                onNavigate: { section in
                    appModel.selectedSection = section
                },
                onNewIssue: {
                    isShowingNewIssueSheet = true
                },
                onNewAgent: {
                    isShowingNewAgentSheet = true
                }
            )
        }
        .sheet(isPresented: $isShowingNewIssueSheet) {
            NewIssueSheet(appModel: appModel, coordinator: coordinator)
        }
        .sheet(isPresented: $isShowingNewAgentSheet) {
            NewAgentSheet(appModel: appModel, coordinator: coordinator)
        }
        .task {
            guard appModel.isBootstrapping else { return }
            await coordinator.start(appModel: appModel)
        }
    }
}
