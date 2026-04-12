import Foundation

public struct AppIdentity: Sendable {
    public static let fallbackProductName = "neurOS"
    public static let fallbackBundleIdentifier = "io.goldneuron.neurOS"
    public static let fallbackVersion = "0.1.0-alpha.13"

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
        productName: Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? fallbackProductName,
        bundleIdentifier: Bundle.main.bundleIdentifier ?? fallbackBundleIdentifier,
        version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? fallbackVersion,
        supportEmail: "hello@goldneuron.io"
    )
}
