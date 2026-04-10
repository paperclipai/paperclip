import Foundation
import NeurOSAppCore

public protocol OperationsSnapshotProviding: Sendable {
    func loadSnapshot() async throws -> OperationsSnapshot
}

public protocol ConnectionStateProviding: Sendable {
    func currentConnectionState() async -> ConnectionState
}

public protocol LoginItemControlling: Sendable {
    func setEnabled(_ isEnabled: Bool) async throws
}

public protocol NotificationsAuthorizing: Sendable {
    func requestAuthorizationIfNeeded() async
}

public protocol LocalNetworkDiscovering: Sendable {
    func discoverPeers() async -> [String]
}

public protocol PrimaryNodePromoting: Sendable {
    func promoteCurrentMac() async throws -> ConnectionState
}

public struct DesktopServices: Sendable {
    public let operations: any OperationsSnapshotProviding
    public let connection: any ConnectionStateProviding
    public let loginItem: any LoginItemControlling
    public let notifications: any NotificationsAuthorizing
    public let localNetwork: any LocalNetworkDiscovering
    public let primaryNode: any PrimaryNodePromoting

    public init(
        operations: any OperationsSnapshotProviding,
        connection: any ConnectionStateProviding,
        loginItem: any LoginItemControlling,
        notifications: any NotificationsAuthorizing,
        localNetwork: any LocalNetworkDiscovering,
        primaryNode: any PrimaryNodePromoting
    ) {
        self.operations = operations
        self.connection = connection
        self.loginItem = loginItem
        self.notifications = notifications
        self.localNetwork = localNetwork
        self.primaryNode = primaryNode
    }
}
