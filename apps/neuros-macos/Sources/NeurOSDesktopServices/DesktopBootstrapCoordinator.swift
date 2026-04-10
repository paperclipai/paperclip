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
        await services.notifications.requestAuthorizationIfNeeded()

        let peers = await services.localNetwork.discoverPeers()
        if peers.isEmpty == false {
            appModel.statusMessage = "Rede local pronta com \(peers.count) nós detectados."
        }

        let connectionState = await services.connection.currentConnectionState()

        do {
            let snapshot = try await services.operations.loadSnapshot()
            appModel.apply(snapshot: snapshot, connectionState: connectionState)
        } catch {
            appModel.connectionState = .degraded(message: "Falha ao carregar a operação inicial.")
            appModel.isBootstrapping = false
            appModel.statusMessage = error.localizedDescription
        }
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
}
