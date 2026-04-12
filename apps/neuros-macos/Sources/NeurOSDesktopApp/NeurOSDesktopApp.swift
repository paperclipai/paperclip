import SwiftUI
import NeurOSAppCore
import NeurOSDesktopFeatures
import NeurOSDesktopServices

@main
struct NeurOSDesktopApp: App {
    @State private var appModel = AppModel()
    private let coordinator = DesktopBootstrapCoordinator(services: .live)

    var body: some Scene {
        WindowGroup {
            RootSplitView(appModel: appModel, coordinator: coordinator)
                .frame(minWidth: 1200, minHeight: 760)
                .tint(GoldNeuronBrand.gold)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1440, height: 900)

        Settings {
            SettingsView(appModel: appModel, coordinator: coordinator)
                .frame(minWidth: 860, minHeight: 780)
                .tint(GoldNeuronBrand.gold)
                .preferredColorScheme(.dark)
        }

        MenuBarExtra("neurOS", systemImage: "waveform.path.ecg.rectangle") {
            VStack(alignment: .leading, spacing: 12) {
                GoldNeuronWordmarkView(
                    title: "goldneuron.io",
                    subtitle: appModel.identity.productName,
                    markSize: 24
                )
                Text(appModel.connectionState.label)
                    .foregroundStyle(.secondary)
                Divider()
                Button("Abrir Central Operacional") {
                    appModel.selectedSection = .operations
                }
                Button("Abrir Configurações") {
                    appModel.selectedSection = .settings
                }
            }
            .padding()
            .frame(width: 260)
        }
    }
}
