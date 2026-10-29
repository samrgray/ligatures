import SwiftUI

// Ligature’s own controls for the contact card: soft raised buttons, plain sections split by
// faint lines, labelled rows and input fields. Built from the theme rather than the system’s
// grouped lists.

/// A small uppercase heading, tracked out.
struct CardLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.9)
            .foregroundStyle(.secondary)
    }
}

/// Rows as plain text on the card, with a faint line above to set the section apart, and an
/// optional heading and note.
struct CardSection<Content: View>: View {
    var title: String? = nil
    var note: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title { CardLabel(text: title) }
            VStack(alignment: .leading, spacing: 0) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
            if let note {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 24)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 0.5) }
    }
}

/// Spacing for a row inside a CardSection. The first sits flush under the line or heading.
struct CardRow: ViewModifier {
    var first = false
    func body(content: Content) -> some View {
        content
            .padding(.top, first ? 0 : 10)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension View {
    func cardRow(first: Bool = false) -> some View { modifier(CardRow(first: first)) }
}

/// Soft, slightly raised buttons that press in when tapped.
struct TactileButtonStyle: ButtonStyle {
    enum Kind { case plain, primary, danger }
    var kind: Kind = .plain
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(kind == .primary ? Theme.card : kind == .danger ? Color.red : Theme.ink)
            .padding(.horizontal, compact ? 12 : 16)
            .frame(minHeight: compact ? 34 : 44)
            .background(
                Capsule().fill(kind == .primary ? Theme.ink : Theme.card)
            )
            .overlay(Capsule().strokeBorder(kind == .primary ? Color.clear : Theme.line, lineWidth: 0.5))
            .shadow(color: Theme.shadow.opacity(pressed ? 0.04 : 0.1), radius: pressed ? 1 : 4, y: pressed ? 0 : 2)
            .scaleEffect(pressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: pressed)
    }
}

/// A round raised icon button (close, more…).
struct RoundIconStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.ink)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Theme.card))
            .overlay(Circle().strokeBorder(Theme.line, lineWidth: 0.5))
            .shadow(color: Theme.shadow.opacity(pressed ? 0.04 : 0.1), radius: pressed ? 1 : 4, y: pressed ? 0 : 2)
            .scaleEffect(pressed ? 0.94 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: pressed)
    }
}

/// An input that reads as plain text, with a line under it while you type.
struct FieldWell: ViewModifier {
    var focused: Bool
    func body(content: Content) -> some View {
        content
            .padding(.vertical, 3)
            .overlay(alignment: .bottom) {
                Rectangle().fill(focused ? Color.accentColor : Color.clear).frame(height: 1).offset(y: 2)
            }
    }
}

extension View {
    func fieldWell(focused: Bool = false) -> some View { modifier(FieldWell(focused: focused)) }
}

/// A switch drawn in the theme.
struct SoftToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack {
                configuration.label
                Spacer()
                ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                    Capsule().fill(configuration.isOn ? Theme.brand : Theme.paper)
                        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))
                        .frame(width: 46, height: 28)
                    Circle().fill(Theme.card)
                        .shadow(color: Theme.shadow.opacity(0.2), radius: 2, y: 1)
                        .frame(width: 22, height: 22)
                        .padding(3)
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isOn)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}
