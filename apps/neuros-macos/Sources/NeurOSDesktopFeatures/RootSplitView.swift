import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct RootSplitView: View {
    @Bindable private var appModel: AppModel
    private let coordinator: DesktopBootstrapCoordinator

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
                case .runtime:
                    RuntimeSectionView(appModel: appModel, coordinator: coordinator)
                case .plugins:
                    PluginsSectionView(appModel: appModel, coordinator: coordinator)
                case .organization:
                    OrganizationSectionView(appModel: appModel, coordinator: coordinator)
                case .settings:
                    SettingsView(appModel: appModel, coordinator: coordinator)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationSplitViewStyle(.balanced)
        .task {
            guard appModel.isBootstrapping else { return }
            await coordinator.start(appModel: appModel)
        }
    }
}
