import SwiftUI

/// A single chat message bubble
struct ChatBubbleView: View {
    let message: ChatMessage

    private var isUser: Bool { message.role == .user }
    private var isAssistant: Bool { message.role == .assistant }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 60) }

            if isAssistant {
                // Assistant avatar
                ZStack {
                    Circle()
                        .fill(Color.accentColor.gradient)
                        .frame(width: 28, height: 28)
                    Image(systemName: "cpu")
                        .font(.caption2.bold())
                        .foregroundStyle(.white)
                }
                .alignmentGuide(.bottom) { d in d[.bottom] }
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                bubbleBody
                timestampLabel
            }

            if isAssistant { Spacer(minLength: 60) }
            if isUser {
                // User avatar
                ZStack {
                    Circle()
                        .fill(Color.secondary.opacity(0.3))
                        .frame(width: 28, height: 28)
                    Image(systemName: "person.fill")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                }
                .alignmentGuide(.bottom) { d in d[.bottom] }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }

    // MARK: - Bubble Body

    @ViewBuilder
    private var bubbleBody: some View {
        if message.isStreaming && message.content.isEmpty {
            // Typing indicator
            TypingIndicatorView()
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(assistantBubbleBackground)
        } else if let error = message.errorMessage {
            // Error state
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.red)
                Text(error)
                    .font(.body)
                    .foregroundStyle(.red)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.red.opacity(0.1), in: BubbleShape(isUser: isUser))
        } else {
            // Normal message
            Text(message.content)
                .font(.body)
                .foregroundStyle(isUser ? .white : .primary)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(isUser ? .primary : .secondary)
                .overlay(
                    // Streaming cursor
                    message.isStreaming ?
                        AnyView(streamingCursor) : AnyView(EmptyView())
                )
        }
    }

    private var userBubbleBackground: some View {
        BubbleShape(isUser: true)
            .fill(Color.accentColor.gradient)
    }

    private var assistantBubbleBackground: some View {
        BubbleShape(isUser: false)
            .fill(.quaternary)
    }

    private var streamingCursor: some View {
        HStack {
            Spacer()
            VStack {
                Spacer()
                BlinkingCursor()
                    .padding(.trailing, 14)
                    .padding(.bottom, 10)
            }
        }
    }

    // MARK: - Timestamp

    private var timestampLabel: some View {
        Text(message.timestamp.formatted(date: .omitted, time: .shortened))
            .font(.caption2)
            .foregroundStyle(.tertiary)
    }
}

// MARK: - Bubble Shape

struct BubbleShape: Shape {
    let isUser: Bool
    private let radius: CGFloat = 16
    private let tailRadius: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addRoundedRect(in: rect, cornerSize: CGSize(width: radius, height: radius))
        return path
    }
}

// MARK: - Typing Indicator

struct TypingIndicatorView: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.secondary.opacity(0.6))
                    .frame(width: 7, height: 7)
                    .offset(y: phase == i ? -3 : 0)
                    .animation(
                        .easeInOut(duration: 0.4)
                        .repeatForever()
                        .delay(Double(i) * 0.15),
                        value: phase
                    )
            }
        }
        .onAppear {
            phase = 1
        }
    }
}

// MARK: - Blinking Cursor

struct BlinkingCursor: View {
    @State private var visible = true

    var body: some View {
        Rectangle()
            .fill(Color.secondary)
            .frame(width: 2, height: 14)
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                    visible = false
                }
            }
    }
}
