import SwiftUI

// MARK: - Date Extensions

extension Date {
    /// Format as a relative time string ("2 hours ago", "just now")
    var relativeString: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }

    /// Format as ISO 8601 string for backup files
    var iso8601String: String {
        ISO8601DateFormatter().string(from: self)
    }
}

// MARK: - String Extensions

extension String {
    /// Truncate the middle of a string for display
    func truncatedMiddle(maxLength: Int = 20) -> String {
        guard count > maxLength else { return self }
        let halfLength = (maxLength - 3) / 2
        return "\(prefix(halfLength))...\(suffix(halfLength))"
    }

    /// Check if string is a valid hexadecimal string
    var isValidHex: Bool {
        let cleaned = hasPrefix("0x") ? String(dropFirst(2)) : self
        return !cleaned.isEmpty && cleaned.allSatisfy { $0.isHexDigit }
    }
}

// MARK: - Data Extensions

extension Data {
    /// Hex string representation
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    /// Initialize from hex string
    init?(hexString: String) {
        let cleaned = hexString.hasPrefix("0x") ? String(hexString.dropFirst(2)) : hexString
        let length = cleaned.count / 2
        var data = Data(capacity: length)
        var index = cleaned.startIndex

        for _ in 0..<length {
            let nextIndex = cleaned.index(index, offsetBy: 2)
            guard let byte = UInt8(cleaned[index..<nextIndex], radix: 16) else {
                return nil
            }
            data.append(byte)
            index = nextIndex
        }

        self = data
    }
}

// MARK: - View Extensions

extension View {
    /// Apply a card-style background
    func cardStyle() -> some View {
        self
            .padding(16)
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.secondary.opacity(0.15))
            )
            .shadow(color: .black.opacity(0.03), radius: 4, y: 2)
    }

    /// Conditional modifier
    @ViewBuilder
    func `if`<Transform: View>(_ condition: Bool, transform: (Self) -> Transform) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}

// MARK: - Color Extensions

extension Color {
    /// Create a color from a hex string
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&int)
        let r, g, b, a: UInt64
        switch cleaned.count {
        case 6:
            (r, g, b, a) = (int >> 16, int >> 8 & 0xFF, int & 0xFF, 255)
        case 8:
            (r, g, b, a) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (r, g, b, a) = (0, 0, 0, 255)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}
