import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct SettingsView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        Form {
            Section("Aplicação") {
                LabeledContent("Produto", value: appModel.identity.productName)
                LabeledContent("Versão", value: appModel.identity.version)
                LabeledContent("Bundle", value: appModel.identity.bundleIdentifier)
            }

            Section("Desktop") {
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
        .formStyle(.grouped)
        .navigationTitle("Configurações")
        .padding(28)
    }
}
