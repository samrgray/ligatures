import SwiftUI
import UIKit

/// Letters for the index down the right side, and which row each one jumps to.
enum AlphaIndex {
    /// Names that don’t start with a letter sort first here, so # is at the top.
    static let letters = ["#"] + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map { String($0) }

    /// The index letter for a sort key: its first letter without accents, or # for anything else.
    static func letter(_ key: String) -> String {
        guard let ch = key.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).first else { return "#" }
        let s = String(ch).uppercased()
        return s.count == 1 && letters.dropFirst().contains(s) ? s : "#"
    }

    private static func rank(_ l: String) -> Int { letters.firstIndex(of: l) ?? 0 }

    /// The first row at that letter, or the next one after it in the rows’ order.
    static func target(_ rowLetters: [String], pick: String, descending: Bool = false) -> Int? {
        guard !rowLetters.isEmpty else { return nil }
        let p = rank(pick)
        return rowLetters.firstIndex { descending ? rank($0) <= p : rank($0) >= p } ?? rowLetters.count - 1
    }
}

/// A–Z down the right edge, as in Contacts: touch or slide along it to jump to a letter.
/// As there, only letters someone’s name starts with jump (with a tick); the rest do nothing.
struct AlphabetScrubber: View {
    /// The letters that have people.
    let available: Set<String>
    let onPick: (String) -> Void
    /// The letter under your finger, whether or not it has people.
    @State private var touching: String?
    @State private var spoken: String? // the letter VoiceOver is on

    private let letters = AlphaIndex.letters

    var body: some View {
        GeometryReader { geo in
            let step = min(16, geo.size.height / CGFloat(letters.count))
            let top = (geo.size.height - step * CGFloat(letters.count)) / 2
            VStack(spacing: 0) {
                ForEach(letters, id: \.self) { l in
                    Text(l)
                        .font(.system(size: min(11, step * 0.72), weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 18, height: step)
                }
            }
            .frame(width: 26, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        let i = min(letters.count - 1, max(0, Int((v.location.y - top) / step)))
                        pick(letters[i])
                    }
                    .onEnded { _ in touching = nil }
            )
        }
        .frame(width: 26)
        .accessibilityElement()
        .accessibilityLabel("Index")
        .accessibilityValue(spoken ?? "")
        .accessibilityAdjustableAction { dir in
            // Steps through the letters that have people.
            let have = letters.filter { available.contains($0) }
            guard !have.isEmpty else { return }
            let i = spoken.flatMap { have.firstIndex(of: $0) }
            switch dir {
            case .increment: spoken = have[i.map { min(have.count - 1, $0 + 1) } ?? 0]
            case .decrement: spoken = have[i.map { max(0, $0 - 1) } ?? 0]
            @unknown default: return
            }
            if let s = spoken { onPick(s) }
        }
    }

    private func pick(_ l: String) {
        guard l != touching else { return }
        touching = l
        guard available.contains(l) else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        onPick(l)
    }
}
