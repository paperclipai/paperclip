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
            SidebarNavigationView(selectedSection: $appModel.selectedSection)
        } detail: {
            Group {
                switch appModel.selectedSection {
                case .operations:
                    OperationsHomeView(appModel: appModel, coordinator: coordinator)
                case .settings:
                    SettingsView(appModel: appModel, coordinator: coordinator)
                default:
                    PlaceholderSectionView(section: appModel.selectedSection)
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

private struct PlaceholderSectionView: View {
    let section: NavigationSection

    var body: some View {
        ContentUnavailableView(
            section.title,
            systemImage: "square.stack.3d.up",
            description: Text("Esta área já está reservada na arquitetura do neurOS macOS e será preenchida com paridade funcional do produto.")
        )
    }
}
