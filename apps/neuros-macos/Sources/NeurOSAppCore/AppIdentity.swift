import Foundation

public struct AppIdentity: Sendable {
    public let productName: String
    public let bundleIdentifier: String
    public let version: String
    public let supportEmail: String

    public init(
        productName: String,
        bundleIdentifier: String,
        version: String,
        supportEmail: String
    ) {
        self.productName = productName
        self.bundleIdentifier = bundleIdentifier
        self.version = version
        self.supportEmail = supportEmail
    }

    public static let current = AppIdentity(
        productName: "neurOS",
        bundleIdentifier: "io.goldneuron.neurOS",
        version: "0.1.0-alpha.1",
        supportEmail: "hello@goldneuron.io"
    )
}
