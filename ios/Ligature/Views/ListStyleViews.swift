import SwiftUI
import UIKit

/// List colors, the same palette as the web. Labels mix the color into the card, so they read
/// in light and dark without transparency.
enum ListColor {
    static let all = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"]

    private static let hex: [String: UInt32] = [
        "red": 0xD4493F, "orange": 0xE2722F, "yellow": 0xC99A12, "green": 0x3F9452, "teal": 0x23928F,
        "blue": 0x3A6BD0, "purple": 0x8657C4, "pink": 0xCF4F8A, "gray": 0x8A8178,
    ]
    private static let neutral: UInt32 = 0x877D73 // the secondary text color

    static func base(_ key: String?) -> Color {
        Color(UIColor(hex: key.flatMap { hex[$0] } ?? neutral))
    }

    /// The color mixed into another: `light` of it over `lightBase` in light mode, `dark` over `darkBase` in dark.
    private static func mix(_ key: String?, _ lightBase: UInt32, _ light: CGFloat, _ darkBase: UInt32, _ dark: CGFloat) -> Color {
        let c = UIColor(hex: key.flatMap { hex[$0] } ?? neutral)
        return Color(UIColor { t in
            t.userInterfaceStyle == .dark ? blend(c, UIColor(hex: darkBase), dark) : blend(c, UIColor(hex: lightBase), light)
        })
    }

    // Over the card (0xFFFDFA light, 0x211F1C dark); text toward the ink.
    static func fill(_ key: String?) -> Color { key == nil ? mix(key, 0xFFFDFA, 0.09, 0x211F1C, 0.12) : mix(key, 0xFFFDFA, 0.16, 0x211F1C, 0.26) }
    static func edge(_ key: String?) -> Color { key == nil ? mix(key, 0xFFFDFA, 0.22, 0x211F1C, 0.26) : mix(key, 0xFFFDFA, 0.30, 0x211F1C, 0.40) }
    static func ink(_ key: String?) -> Color { key == nil ? mix(key, 0x2A2622, 0.45, 0xF1ECE5, 0.45) : mix(key, 0x2A2622, 0.68, 0xF1ECE5, 0.62) }

    /// The selected tab: the color itself, a touch lighter in dark mode.
    static func solid(_ key: String?) -> Color { mix(key, 0xFFFDFA, 1, 0xF1ECE5, 0.85) }
    /// Text on `solid`: light, except on yellow, where dark reads better.
    static func onSolid(_ key: String?) -> Color { Color(UIColor(hex: key == "yellow" ? 0x2A2622 : 0xFFFDFA)) }

    /// A dot in the color, for menus (which draw images but not shapes).
    static func dot(_ key: String) -> UIImage {
        let c = UIColor(hex: hex[key] ?? neutral)
        let img = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { ctx in
            c.setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 1, y: 1, width: 10, height: 10))
        }
        return img.withRenderingMode(.alwaysOriginal)
    }

    private static func blend(_ a: UIColor, _ b: UIColor, _ t: CGFloat) -> UIColor {
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 * t + r2 * (1 - t), green: g1 * t + g2 * (1 - t), blue: b1 * t + b2 * (1 - t), alpha: 1)
    }
}

/// A list as a label: its emoji and name, in its color.
struct ListBadge: View {
    let name: String
    let style: ListStyle
    var large = false

    var body: some View {
        HStack(spacing: large ? 4 : 3) {
            if let e = style.emoji { Text(e).font(.system(size: large ? 12 : 10)) }
            Text(name).lineLimit(1)
        }
        .font(.system(size: large ? 14 : 12, weight: .medium))
        .foregroundStyle(ListColor.ink(style.color))
        .padding(.horizontal, large ? 10 : 7)
        .frame(height: large ? 26 : 20)
        .background(Capsule().fill(ListColor.fill(style.color)))
        .overlay(Capsule().strokeBorder(ListColor.edge(style.color), lineWidth: 0.75))
        .shadow(color: Theme.shadow.opacity(0.06), radius: 0.5, y: 0.5)
        .accessibilityElement(children: .combine)
    }
}

/// A contact’s lists as labels, wrapping onto more lines.
struct ListBadges: View {
    let lists: [ContactList]
    let accountId: String
    var large = false
    @Environment(Store.self) private var store

    var body: some View {
        FlowLayout(spacing: large ? 6 : 4) {
            ForEach(lists) { l in
                ListBadge(name: l.name, style: store.style(ListRef(accountId: accountId, id: l.id)), large: large)
            }
        }
    }
}

/// Lays out views in rows, wrapping when the next one doesn’t fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: rows.map { $0.width }.max() ?? 0, height: rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - s.height) / 2), proposal: ProposedViewSize(width: min(s.width, bounds.width), height: s.height))
                x += min(s.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        for (i, v) in subviews.enumerated() {
            let s = v.sizeThatFits(.unspecified)
            let w = min(s.width, width)
            if let last = rows.last, last.width + spacing + w <= width {
                rows[rows.count - 1] = (last.items + [i], last.width + spacing + w, max(last.height, s.height))
            } else {
                rows.append(([i], w, s.height))
            }
        }
        return rows
    }
}

/// Choose a list’s color and emoji.
struct ListStyleView: View {
    let list: ContactList
    let accountId: String
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var color: String?
    @State private var emoji: String?
    @State private var typed = ""

    static let suggestions = ["⭐", "❤️", "🏠", "👪", "🧑‍🤝‍🧑", "💼", "🎓", "🏫", "⚽", "🏃", "🎵", "🎨", "📚", "☕", "🍽️", "🍷", "✈️", "🌱", "🐶", "🎉", "🙏", "🏥", "💻", "📍"]

    private var ref: ListRef { ListRef(accountId: accountId, id: list.id) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ListBadge(name: list.name, style: ListStyle(accountId: accountId, id: list.id, color: color, emoji: emoji), large: true)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
                Section("Color") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 36), spacing: 8)], spacing: 12) {
                        swatch(nil)
                        ForEach(ListColor.all, id: \.self) { swatch($0) }
                    }
                    .padding(.vertical, 6)
                }
                Section("Emoji") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 40), spacing: 4)], spacing: 4) {
                        emojiButton(nil)
                        ForEach(choices, id: \.self) { emojiButton($0) }
                    }
                    .padding(.vertical, 4)
                    TextField("Or type any emoji", text: $typed)
                        .onChange(of: typed) { _, t in
                            if let first = t.trimmingCharacters(in: .whitespaces).first { emoji = String(first) }
                        }
                }
            }
            .navigationTitle("Color & Icon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        let (c, e) = (color, emoji)
                        Task { await store.setStyle(ref, color: c, emoji: e) }
                        dismiss()
                    }
                    .bold()
                }
            }
            .onAppear {
                let s = store.style(ref)
                color = s.color
                emoji = s.emoji
            }
        }
        .presentationDetents([.large])
    }

    /// The suggestions, plus the list’s own emoji if it isn’t one of them.
    private var choices: [String] {
        if let e = store.style(ref).emoji, !Self.suggestions.contains(e) { return [e] + Self.suggestions }
        return Self.suggestions
    }

    private func swatch(_ key: String?) -> some View {
        let on = color == key
        return Button { color = key } label: {
            ZStack {
                if key == nil {
                    Circle().fill(Theme.card).overlay(Circle().strokeBorder(Theme.line, lineWidth: 1.5))
                    Rectangle().fill(Color.secondary).frame(width: 18, height: 1.5).rotationEffect(.degrees(-45))
                } else {
                    Circle().fill(ListColor.base(key))
                }
            }
            .frame(width: 30, height: 30)
            .padding(3)
            .overlay(Circle().strokeBorder(on ? (key == nil ? Color.accentColor : ListColor.base(key)) : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key?.capitalized ?? "No color")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func emojiButton(_ e: String?) -> some View {
        let on = emoji == e
        return Button {
            emoji = e
            typed = ""
        } label: {
            Group {
                if let e { Text(e).font(.system(size: 22)) } else { Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary) }
            }
            .frame(width: 40, height: 40)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(on ? ListColor.fill("blue") : .clear))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(on ? Color.accentColor : .clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(e ?? "No emoji")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
