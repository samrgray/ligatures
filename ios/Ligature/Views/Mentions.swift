import SwiftUI

// @-mentions: type “@” and part of a name in notes or your text fields to tag another contact.
// They’re stored as plain “@Full Name” (so notes read naturally in Google and on iPhone) and
// shown as links to that person. The same rules as the web’s mentions.js.

struct Mention {
    let range: Range<String.Index>
    let id: String
    let name: String
}

enum Mentions {
    static let scheme = "ligature-mention"

    private static func isWord(_ c: Character?) -> Bool {
        guard let c else { return false }
        return c.isLetter || c.isNumber
    }

    private static func clean(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Every “@Name” in the text that names one of these contacts. Longer names win (“@Ann Lee”
    /// over “@Ann”); an @ inside a word (an email address) isn’t a mention.
    /// `known`: who the server remembers each mention pointing to, which wins.
    static func find(in text: String, contacts: [ContactRow], known: [MentionRef] = []) -> [Mention] {
        guard text.contains("@") else { return [] }
        var byFirst: [String: [(id: String, name: String, rank: Int)]] = [:]
        func add(_ id: String, _ raw: String, _ rank: Int) {
            let name = clean(raw)
            guard !name.isEmpty else { return }
            let first = String(name.split(separator: " ").first ?? "").lowercased()
            byFirst[first, default: []].append((id, name, rank))
        }
        for k in known { add(k.id, k.name, 0) }
        for c in contacts { add(c.id, c.displayName, 1) }
        byFirst = byFirst.mapValues { $0.sorted { $0.name.count != $1.name.count ? $0.name.count > $1.name.count : $0.rank < $1.rank } }

        var out: [Mention] = []
        var i = text.startIndex
        while let at = text[i...].firstIndex(of: "@") {
            defer { if i <= at { i = text.index(after: at) } }
            if at > text.startIndex, isWord(text[text.index(before: at)]) { continue }
            let rest = text[text.index(after: at)...]
            let word = rest.prefix { !$0.isWhitespace && $0 != "@" }.lowercased()
            let trimmed = String(word.reversed().drop { ".,;:!?)’'”\"".contains($0) }.reversed())
            let cands = byFirst[word] ?? byFirst[trimmed] ?? []
            for c in cands {
                guard let r = rest.range(of: c.name, options: [.caseInsensitive, .anchored]) else { continue }
                if r.upperBound < text.endIndex, isWord(text[r.upperBound]) { continue }
                out.append(Mention(range: at..<r.upperBound, id: c.id, name: c.name))
                i = r.upperBound
                break
            }
        }
        return out
    }

    /// The text with each mention a link (handled by `openMentions`).
    static func attributed(_ text: String, contacts: [ContactRow], known: [MentionRef] = []) -> AttributedString {
        var out = AttributedString()
        var at = text.startIndex
        for m in find(in: text, contacts: contacts, known: known) {
            out += AttributedString(String(text[at..<m.range.lowerBound]))
            var link = AttributedString(String(text[m.range]))
            link.link = URL(string: "\(scheme):\(m.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? m.id)")
            link.foregroundColor = Color.accentColor
            out += link
            at = m.range.upperBound
        }
        out += AttributedString(String(text[at...]))
        return out
    }

    /// The “@partial name” being typed at the end of the text, if any.
    static func typing(_ text: String) -> String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex, isWord(text[text.index(before: at)]) { return nil }
        let q = String(text[text.index(after: at)...])
        if q.count > 40 || q.contains("\n") || q.hasPrefix(" ") || q.contains("  ") || q.split(separator: " ").count > 3 { return nil }
        return q
    }

    static func suggestions(for query: String, contacts: [ContactRow]) -> [ContactRow] {
        let q = query.lowercased()
        var seen = Set<String>()
        return contacts
            .compactMap { c -> (ContactRow, Int, String)? in
                let name = clean(c.displayName)
                guard !name.isEmpty, !seen.contains(name) else { return nil }
                let lower = name.lowercased()
                let words = lower.split(separator: " ")
                let rank: Int
                if q.isEmpty || lower.hasPrefix(q) { rank = 0 }
                else if words.indices.contains(where: { words[$0...].joined(separator: " ").hasPrefix(q) }) { rank = 1 }
                else { return nil }
                seen.insert(name)
                return (c, rank, name)
            }
            .sorted { $0.1 != $1.1 ? $0.1 < $1.1 : $0.2.localizedCompare($1.2) == .orderedAscending }
            .prefix(8)
            .map(\.0)
    }
}

extension View {
    /// Mention links open that person’s card.
    func openMentions() -> some View { modifier(OpenMentions()) }
}

private struct OpenMentions: ViewModifier {
    @Environment(\.openPerson) private var openPerson

    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            guard url.scheme == Mentions.scheme else { return .systemAction }
            let id = String(url.absoluteString.dropFirst(Mentions.scheme.count + 1)).removingPercentEncoding ?? ""
            if !id.isEmpty { openPerson(id) }
            return .handled
        })
    }
}

/// Text with its mentions as links.
struct MentionText: View {
    let text: String
    var known: [MentionRef] = []
    @Environment(Store.self) private var store

    var body: some View {
        Text(Mentions.attributed(text, contacts: store.contacts, known: known))
            .multilineTextAlignment(.leading)
            .openMentions()
    }
}

/// Notes on a contact, with mentions as links. Long-press to copy.
struct NotesRow: View {
    let notes: String
    var known: [MentionRef] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("notes").font(.app(.caption)).foregroundStyle(.secondary)
            MentionText(text: notes, known: known)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu {
            Button { copyToClipboard(notes) } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }
}

/// The people a field’s value mentions, as links under its box.
struct MentionLinks: View {
    let text: String
    var known: [MentionRef] = []
    @Environment(Store.self) private var store
    @Environment(\.openPerson) private var openPerson

    var body: some View {
        let found = Mentions.find(in: text, contacts: store.contacts, known: known)
        let people = found.reduce(into: [Mention]()) { acc, m in if !acc.contains(where: { $0.id == m.id }) { acc.append(m) } }
        if !people.isEmpty {
            FlowLinks(people: people) { openPerson($0) }
        }
    }

    private struct FlowLinks: View {
        let people: [Mention]
        let open: (String) -> Void

        var body: some View {
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(people, id: \.id) { m in
                        Button("@\(m.name)") { open(m.id) }
                            .font(.app(.subheadline, .medium))
                            .foregroundStyle(Color.accentColor)
                            .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

/// While you type “@” and part of a name, the people it could be; tap one to fill in their name.
struct MentionSuggestions: View {
    @Binding var text: String
    @Environment(Store.self) private var store

    var body: some View {
        if let q = Mentions.typing(text) {
            let people = Mentions.suggestions(for: q, contacts: store.contacts)
            if !people.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(people) { c in
                            Button { pick(c, query: q) } label: {
                                HStack(spacing: 6) {
                                    Avatar(url: c.photoUrl, initials: c.initials, size: 22)
                                    Text(c.displayName).lineLimit(1)
                                }
                                .font(.app(.subheadline, .medium))
                                .padding(.leading, 4)
                                .padding(.trailing, 10)
                                .padding(.vertical, 4)
                                .background(Capsule().fill(Theme.card))
                                .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollIndicators(.hidden)
                .accessibilityLabel("Tag someone")
            }
        }
    }

    private func pick(_ c: ContactRow, query: String) {
        guard text.hasSuffix(query), let at = text.dropLast(query.count).lastIndex(of: "@") else { return }
        let name = c.displayName.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        text = String(text[..<at]) + "@\(name) "
    }
}
