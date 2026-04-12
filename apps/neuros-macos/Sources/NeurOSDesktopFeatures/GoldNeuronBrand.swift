import SwiftUI

public enum GoldNeuronBrand {
    public static let background = Color(red: 11 / 255, green: 14 / 255, blue: 20 / 255)
    public static let backgroundRaised = Color(red: 18 / 255, green: 22 / 255, blue: 32 / 255)
    public static let surface = Color(red: 28 / 255, green: 34 / 255, blue: 48 / 255)
    public static let surfaceRaised = Color(red: 34 / 255, green: 40 / 255, blue: 58 / 255)
    public static let separator = Color.white.opacity(0.14)
    public static let textPrimary = Color(red: 245 / 255, green: 245 / 255, blue: 247 / 255)
    public static let textSecondary = Color(red: 194 / 255, green: 201 / 255, blue: 212 / 255)
    public static let textTertiary = Color(red: 145 / 255, green: 154 / 255, blue: 168 / 255)
    public static let gold = Color(red: 253 / 255, green: 185 / 255, blue: 49 / 255)
    public static let goldDeep = Color(red: 229 / 255, green: 177 / 255, blue: 67 / 255)
}

struct GoldNeuronSceneBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    GoldNeuronBrand.background,
                    GoldNeuronBrand.backgroundRaised,
                    GoldNeuronBrand.background,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Circle()
                .fill(GoldNeuronBrand.gold.opacity(0.14))
                .frame(width: 520, height: 520)
                .blur(radius: 120)
                .offset(x: 300, y: -280)

            Circle()
                .fill(Color.white.opacity(0.05))
                .frame(width: 260, height: 260)
                .blur(radius: 80)
                .offset(x: -360, y: -180)

            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [GoldNeuronBrand.gold.opacity(0.04), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .blendMode(.plusLighter)
        }
        .ignoresSafeArea()
    }
}

struct GoldNeuronMarkView: View {
    let size: CGFloat
    var opacity: Double = 1
    var glowOpacity: Double = 0.16

    var body: some View {
        ZStack {
            Circle()
                .fill(GoldNeuronBrand.gold.opacity(glowOpacity))
                .frame(width: size * 0.82, height: size * 0.82)
                .blur(radius: size * 0.14)

            Image("gn_isotipo_transparent", bundle: .module)
                .resizable()
                .interpolation(.high)
                .antialiased(true)
                .scaledToFit()
                .frame(width: size, height: size)
        }
        .frame(width: size, height: size)
        .opacity(opacity)
        .accessibilityHidden(true)
    }
}

public struct GoldNeuronWordmarkView: View {
    let title: String
    var subtitle: String? = nil
    var markSize: CGFloat = 34

    public init(title: String, subtitle: String? = nil, markSize: CGFloat = 34) {
        self.title = title
        self.subtitle = subtitle
        self.markSize = markSize
    }

    public var body: some View {
        HStack(spacing: 14) {
            GoldNeuronMarkView(size: markSize)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: max(18, markSize * 0.7), weight: .thin, design: .rounded))
                    .foregroundStyle(GoldNeuronBrand.textPrimary)
                    .tracking(0.4)

                if let subtitle, subtitle.isEmpty == false {
                    Text(subtitle.uppercased())
                        .font(.system(size: 10, weight: .regular, design: .rounded))
                        .foregroundStyle(GoldNeuronBrand.goldDeep)
                        .tracking(2.4)
                }
            }
        }
    }
}
