import SwiftUI

struct ContactDetailView: View {
    let id: String
    /// False for the cards beside the one you’re looking at: they don’t add toolbar buttons.
    var active = true
    /// Closes the card (back to the list). The carousel passes its own, since a card inside it
    /// can’t reliably dismiss the screen.
    var onClose: (() -> Void)? = nil
    /// For people shown together: everyone in the entry, who’s shown, and how to switch.
    var members: [ContactRow] = []
    var chosen: String? = nil
    var onChoose: ((String) -> Void)? = nil
    /// How far the card is pulled down past its top, and whether you’ve let go (to close it).
    var onPull: ((CGFloat, Bool) -> Void)? = nil
    @State private var pull: CGFloat = 0
    @Environment(Store.self) private var store
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var pickingLists = false
    @State private var showPhoto = false
    @State private var editingRelationship: RelationshipEditTarget?

    private var row: ContactRow? { store.row(id) }
    private var archived: ContactDetail.Archived? { detail?.archived }
    @State private var confirmForget = false
    @State private var working = false
    private var detail: ContactDetail? { store.details[id] }
    @State private var pastOpen = false
    /// Which of their addresses the header’s map shows.
    @State private var placeKey: String?
    /// Where the photo and name sit in the card, for the map behind them.
    @State private var heroFrame: CGRect = .zero
    /// The middle of their photo: the place on the map is level with it.
    @State private var photoMidY: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    topBar
                    if detail?.draft == true && archived == nil { draftBanner }
                    header
                    if let d = detail {
                        googleSections(d)
                    } else if row != nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 20)
                    }
                    if let archived {
                        CardSection {
                            Text("Archived \(Date(timeIntervalSince1970: archived.at / 1000).formatted(date: .abbreviated, time: .omitted)). \(detail?.draft == true ? "Restore brings it back as a draft." : "Not in Google Contacts; everything is kept here. Restore puts them back in Google\(archived.groups.contains { $0 != "contactGroups/myContacts" } ? ", on the same lists" : "").")")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .cardRow(first: true)
                        }
                    } else {
                        if let row { listsSection(row) }
                        if row != nil { RelationshipsSection(id: id, editing: $editingRelationship) }
                    }
                    yourFields
                    if !pastFields.isEmpty { pastSection }
                }
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 60)
                // Where they live (or work), faintly behind the top of the card down to their name,
                // with the place level with their photo and name.
                .background(alignment: .top) {
                    if let place = headerPlace, heroFrame.maxY > 0 {
                        HeaderMap(point: place.point, focusY: photoMidY)
                            .frame(height: heroFrame.maxY)
                            .id(place.id)
                    }
                }
                .coordinateSpace(.named("detail"))
                // In a card you can pull down, the card moves instead of its contents: undo the
                // scroll view’s stretch at the top.
                .offset(y: onPull == nil ? 0 : -pull)
            }
            .scrollIndicators(.hidden)
            // Pulled down past the top: the card follows, and letting go far enough closes it.
            // Only changes while pulled past the top, so ordinary scrolling doesn’t update anything.
            .onScrollGeometryChange(for: CGFloat.self) { g in max(0, (-(g.contentOffset.y + g.contentInsets.top)).rounded()) } action: { _, v in
                pull = v
                onPull?(v, false)
            }
            .onScrollPhaseChange { old, new in
                if old == .interacting && new != .interacting { onPull?(pull, true) }
            }
            .onAppear {
                if store.demo, store.demoScreen == "fields" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { proxy.scrollTo("fields", anchor: .top) }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete this contact forever?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Delete Forever", role: .destructive) {
                Task {
                    await store.archive(.forget, ids: [id])
                    close()
                }
            }
        } message: {
            Text("Their details, your fields and relationships are removed from Ligature. This can’t be undone.")
        }
        .task(id: id) { await store.loadDetail(id) }
        .sheet(isPresented: $editing) {
            if let d = detail {
                ContactEditView(mode: .edit(d), onDeleted: { close() })
            }
        }
        .sheet(isPresented: $pickingLists) {
            if let row { ListPickerView(ids: [row.id], accountId: row.accountId) }
        }
        .sheet(item: $editingRelationship) { t in
            RelationshipEditor(me: t.me, existing: t.existing)
        }
        .fullScreenCover(isPresented: $showPhoto) {
            PhotoViewer(url: detail?.card.photoUrl ?? row?.photoUrl ?? "")
        }
        .onAppear {
            guard store.demo else { return }
            if store.demoScreen == "edit" { editing = true }
            if store.demoScreen == "lists" { pickingLists = true }
            if store.demoScreen == "relate" { editingRelationship = RelationshipEditTarget(me: id, existing: store.relationships(of: id).first) }
        }
    }

    private func close() {
        if let onClose { onClose() } else { dismiss() }
    }

    /// Switch between people shown together, and the card’s actions: all on the card.
    /// (Pull the card down to close it.)
    private var topBar: some View {
        HStack(spacing: 10) {
            if members.count > 1 {
                HStack(spacing: 2) {
                    ForEach(members) { m in
                        let on = (chosen ?? id) == m.id
                        Button { onChoose?(m.id) } label: {
                            Text(m.givenName.isEmpty ? m.displayName : m.givenName)
                                .font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 12)
                                .frame(height: 30)
                                .background(Capsule().fill(on ? Theme.card : Color.clear))
                                .shadow(color: Theme.shadow.opacity(on ? 0.12 : 0), radius: 2, y: 1)
                                .foregroundStyle(on ? Theme.ink : Color.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(3)
                .background(Capsule().fill(Theme.paper.opacity(0.8)))
            }
            Spacer(minLength: 0)
            Group {
                if archived != nil {
                    Menu {
                        Button(role: .destructive) { confirmForget = true } label: { Label("Delete Forever", systemImage: "trash") }
                    } label: { roundIcon("ellipsis") }
                    .accessibilityLabel("More")
                    Button("Restore") {
                        working = true
                        Task {
                            await store.archive(.restore, ids: [id])
                            await store.loadDetail(id)
                            working = false
                        }
                    }
                    .buttonStyle(TactileButtonStyle(kind: .primary, compact: true))
                    .disabled(working)
                } else {
                    Menu {
                        Button {
                            working = true
                            Task {
                                let done = await store.archive(.archive, ids: [id], etags: [id: detail?.etag ?? ""])
                                working = false
                                if !done.isEmpty { close() }
                            }
                        } label: { Label("Archive", systemImage: "archivebox") }
                    } label: { roundIcon("ellipsis") }
                    .accessibilityLabel("More")
                    .disabled(detail == nil || working)
                    Button("Edit") { editing = true }
                        .buttonStyle(TactileButtonStyle(compact: true))
                        .disabled(detail == nil)
                }
            }
            // The cards beside this one keep their layout but not their buttons.
            .opacity(active ? 1 : 0)
            .allowsHitTesting(active)
            .accessibilityHidden(!active)
        }
    }

    private func roundIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.ink)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Theme.card))
            .overlay(Circle().strokeBorder(Theme.line, lineWidth: 0.5))
            .shadow(color: Theme.shadow.opacity(0.1), radius: 4, y: 2)
    }

    @State private var promoting = false
    @State private var promoteError: String?

    /// Drafts are only in Ligature; one tap makes them real.
    private var draftBanner: some View {
        Group {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    DraftTag()
                    Text("Only in Ligature").font(.subheadline.weight(.medium))
                }
                Text("Not in Google Contacts, so not on your iPhone or Mac.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    promoting = true
                    Task {
                        do { try await store.promote(id) } catch { promoteError = error.localizedDescription }
                        promoting = false
                    }
                } label: {
                    if promoting { ProgressView().frame(maxWidth: .infinity) } else { Text("Add to Google").frame(maxWidth: .infinity) }
                }
                .buttonStyle(TactileButtonStyle(kind: .primary))
                .disabled(promoting)
            }
            .padding(16)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.brand.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.brand.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        }
        .alert("Couldn’t Add to Google", isPresented: Binding(get: { promoteError != nil }, set: { if !$0 { promoteError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(promoteError ?? "")
        }
    }

    // MARK: Header: photo, name, and message / call / email

    private var header: some View {
        let card = detail?.card
        let photo = card?.photoUrl ?? row?.photoUrl ?? ""
        let name = card?.displayName ?? row?.displayName ?? ""
        let subtitle = [card?.title ?? row?.title ?? "", card?.organization ?? row?.organization ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        let phones = unique(card?.phones ?? (row.map { $0.phone.isEmpty ? [] : [Labeled(value: $0.phone, label: "")] } ?? []))
        let emails = unique(card?.emails ?? (row.map { $0.email.isEmpty ? [] : [Labeled(value: $0.email, label: "")] } ?? []))
        let places = self.places
        let place = headerPlace
        return Group {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 10) {
                    Button { if !photo.isEmpty { showPhoto = true } } label: {
                        Avatar(url: photo, initials: card?.initials ?? row?.initials ?? "?", size: 104)
                    }
                    .buttonStyle(.plain)
                    .disabled(photo.isEmpty)
                    .accessibilityLabel(photo.isEmpty ? "No photo" : "Enlarge photo")
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("detail")).midY } action: { photoMidY = $0 }
                    // With several addresses, which one the map shows: on the title’s line, or the
                    // name’s when there’s no title.
                    let picker = places.count > 1 ? placePicker(places, current: place?.id) : nil
                    HStack(alignment: .firstTextBaseline) {
                        Text(name.isEmpty ? "No Name" : name)
                            .font(.title.weight(.semibold))
                        if subtitle.isEmpty, let picker {
                            Spacer(minLength: 8)
                            picker
                        }
                    }
                    if !subtitle.isEmpty {
                        HStack(alignment: .firstTextBaseline) {
                            Text(subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            if let picker {
                                Spacer(minLength: 8)
                                picker
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, place == nil ? 0 : 14)
                // The map behind (drawn by the card) reaches down to here.
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("detail")) } action: { heroFrame = $0 }
                HStack(spacing: 8) {
                    ActionButton(title: "message", icon: "message.fill", options: phones) { Links.sms($0) }
                    ActionButton(title: "call", icon: "phone.fill", options: phones) { Links.tel($0) }
                    ActionButton(title: "mail", icon: "envelope.fill", options: emails) { Links.mail($0) }
                    if onSignal {
                        let user = signalUsername
                        if user.lowercased().hasPrefix("https://signal.me/#"), let u = URL(string: user) {
                            Button { openURL(u) } label: { ActionFace(title: "signal", icon: "bubble.left.and.bubble.right.fill", enabled: true) }
                                .buttonStyle(.plain)
                        } else if user.isEmpty && !phones.isEmpty {
                            ActionButton(title: "signal", icon: "bubble.left.and.bubble.right.fill", options: phones) { Address.signal($0) }
                        } else {
                            // A plain username can’t be linked to, so it (or their name) is copied for Signal’s search.
                            Button {
                                copyToClipboard(user.isEmpty ? name : user)
                                if let u = URL(string: "sgnl://") { openURL(u) }
                            } label: { ActionFace(title: "signal", icon: "bubble.left.and.bubble.right.fill", enabled: true) }
                            .buttonStyle(.plain)
                            .accessibilityHint("Copies their \(user.isEmpty ? "name" : "username") and opens Signal, so you can paste it into search")
                        }
                    }
                }
                .padding(.top, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct Place: Identifiable {
        let id: String
        let title: String
        let point: MapPoint
    }

    /// The place the map behind the header shows.
    private var headerPlace: Place? {
        let places = self.places
        return places.first { $0.id == placeKey } ?? places.first
    }

    /// Their places on the map, one per address that could be found.
    private var places: [Place] {
        let points = store.mapPoints.filter { $0.id == id }
        var seen: [String: Int] = [:]
        return points.map { p in
            let n = (seen[p.type] ?? 0) + 1
            seen[p.type] = n
            let title = p.type.capitalized + (n > 1 ? " \(n)" : "")
            return Place(id: "\(p.type)-\(n)", title: title, point: p)
        }
        // Home first, as on the card.
        .sorted { ($0.point.type == "home" ? 0 : 1) < ($1.point.type == "home" ? 0 : 1) }
    }

    /// Which address the map shows: just its name and a caret, like their title, opening a menu.
    private func placePicker(_ places: [Place], current: String?) -> some View {
        Menu {
            Picker("Address", selection: Binding(get: { current ?? "" }, set: { k in withAnimation(.easeInOut(duration: 0.25)) { placeKey = k } })) {
                ForEach(places) { p in Text(p.title).tag(p.id) }
            }
        } label: {
            HStack(spacing: 3) {
                Text(places.first { $0.id == current }?.title ?? "")
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .tint(.secondary)
        .accessibilityLabel("Address on the map")
    }

    private func ownValue(_ key: String) -> String {
        guard let f = store.fields.first(where: { $0.key == key }) else { return "" }
        return row?.fields[f.id] ?? detail?.fields[f.id] ?? ""
    }

    private var signalUsername: String { ownValue("signal_username").trimmingCharacters(in: .whitespaces) }

    private var onSignal: Bool {
        detail?.archived == nil && (ownValue("signal") == "1" || !signalUsername.isEmpty)
    }

    private func unique(_ list: [Labeled]) -> [Labeled] {
        var seen = Set<String>()
        return list.filter { seen.insert($0.value.lowercased().filter { !$0.isWhitespace }).inserted }
    }

    // MARK: What Google has

    @ViewBuilder
    private func googleSections(_ d: ContactDetail) -> some View {
        let c = d.card
        if !c.phones.isEmpty {
            CardSection {
                ForEach(Array(c.phones.enumerated()), id: \.element.id) { i, p in
                    ValueRow(label: p.label.isEmpty ? "phone" : p.label, value: p.value, url: Links.tel(p.value)) {
                        Button { if let u = Links.sms(p.value) { openURL(u) } } label: { Image(systemName: "message.fill") }
                            .buttonStyle(RoundIconStyle())
                            .accessibilityLabel("Message \(p.value)")
                    } menu: {
                        Button { if let u = Links.tel(p.value) { openURL(u) } } label: { Label("Call", systemImage: "phone") }
                        Button { if let u = Links.sms(p.value) { openURL(u) } } label: { Label("Message", systemImage: "message") }
                    }
                    .cardRow(first: i == 0)
                }
            }
        }
        if !c.emails.isEmpty {
            CardSection {
                ForEach(Array(c.emails.enumerated()), id: \.element.id) { i, e in
                    ValueRow(label: e.label.isEmpty ? "email" : e.label, value: e.value, url: Links.mail(e.value)).cardRow(first: i == 0)
                }
            }
        }
        if !c.addresses.isEmpty {
            CardSection {
                ForEach(Array(c.addresses.enumerated()), id: \.element.id) { i, a in
                    ValueRow(label: a.label.isEmpty ? "address" : a.label, value: a.value, url: Links.maps(a.value), tinted: false).cardRow(first: i == 0)
                }
            }
        }
        if !c.urls.isEmpty {
            CardSection {
                ForEach(Array(c.urls.enumerated()), id: \.element.id) { i, u in
                    ValueRow(label: u.label.isEmpty ? "website" : u.label, value: u.value, url: Links.web(u.value)).cardRow(first: i == 0)
                }
            }
        }
        let dates: [(String, String)] = (c.birthday.isEmpty ? [] : [("birthday", c.birthday)])
            + c.events.map { ($0.label.isEmpty ? "date" : $0.label, $0.value) }
            + c.relations.map { ($0.label.isEmpty ? "related" : $0.label, $0.value) }
        if !dates.isEmpty {
            CardSection {
                ForEach(Array(dates.enumerated()), id: \.offset) { i, x in
                    ValueRow(label: x.0, value: x.1, url: nil, tinted: false).cardRow(first: i == 0)
                }
            }
        }
        if !c.notes.isEmpty {
            CardSection { ValueRow(label: "notes", value: c.notes, url: nil, tinted: false).cardRow(first: true) }
        }
    }

    // MARK: Lists

    private func listsSection(_ row: ContactRow) -> some View {
        let lists = store.lists(for: row.accountId).filter { row.groups.contains($0.id) && $0.id != "contactGroups/myContacts" }
        return CardSection {
            Button { pickingLists = true } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("lists").font(.caption).foregroundStyle(.secondary)
                        if lists.isEmpty {
                            Text("Add to a List").foregroundStyle(Color.accentColor)
                        } else {
                            ListBadges(lists: lists, accountId: row.accountId, large: true)
                                .accessibilityLabel(lists.map(\.name).joined(separator: ", "))
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color(.tertiaryLabel))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .cardRow(first: true)
        }
    }

    // MARK: Your fields

    private var contactAccount: String? { row?.accountId ?? detail?.account.id }
    private var contactGroups: [String] { row?.groups ?? detail?.card.groups ?? [] }
    private func stored(_ f: FieldDef) -> String { row?.fields[f.id] ?? detail?.fields[f.id] ?? "" }

    /// Every-contact fields, plus the fields of lists they’re on.
    private var currentFields: [FieldDef] {
        store.fields.filter { $0.applies(accountId: contactAccount, groups: contactGroups) }
    }

    /// Values in a list’s fields they’re no longer on, or whose list was deleted.
    private var pastFields: [FieldDef] {
        store.fields.filter { !$0.applies(accountId: contactAccount, groups: contactGroups) && !stored($0).isEmpty }
    }

    private func listName(_ f: FieldDef) -> (name: String, deleted: Bool) {
        if let accountId = f.accountId, let l = store.lists(for: accountId).first(where: { $0.id == f.listId }) { return (l.name, false) }
        return (f.listName ?? "a list", true)
    }

    @ViewBuilder
    private var yourFields: some View {
        let own = currentFields.filter { $0.listId == nil }
        CardSection(title: "Your fields", note: "Only in Ligature. Never synced to Google, iPhone or Mac.") {
            if store.fields.isEmpty {
                Text("No fields yet. Add them in Ligature on the web.").foregroundStyle(.secondary).cardRow(first: true)
            }
            ForEach(Array(own.enumerated()), id: \.element.id) { i, f in
                FieldEditor(contactId: id, field: f, stored: stored(f)).cardRow(first: i == 0)
            }
        }
        .id("fields")
        // A list’s own fields, under the list’s name.
        ForEach(listFieldGroups, id: \.listId) { group in
            CardSection(title: group.name) {
                ForEach(Array(group.fields.enumerated()), id: \.element.id) { i, f in
                    FieldEditor(contactId: id, field: f, stored: stored(f)).cardRow(first: i == 0)
                }
            }
        }
    }

    private var listFieldGroups: [(listId: String, name: String, fields: [FieldDef])] {
        var order: [String] = []
        var byList: [String: [FieldDef]] = [:]
        for f in currentFields {
            guard let l = f.listId else { continue }
            if byList[l] == nil { order.append(l) }
            byList[l, default: []].append(f)
        }
        return order.map { l in (l, listName(byList[l]![0]).name, byList[l]!) }
    }

    private var pastGroups: [(key: String, name: String, deleted: Bool, fields: [FieldDef])] {
        var order: [String] = []
        var byList: [String: [FieldDef]] = [:]
        for f in pastFields {
            let k = "\(f.accountId ?? "")|\(f.listId ?? "")"
            if byList[k] == nil { order.append(k) }
            byList[k, default: []].append(f)
        }
        return order.map { k in
            let l = listName(byList[k]![0])
            return (k, l.name, l.deleted, byList[k]!)
        }
    }

    /// Collapsed until you open it; values grouped under the list they came from.
    private var pastSection: some View {
        CardSection(note: "From lists they’re no longer on, or that were deleted.") {
            Button { withAnimation(.snappy) { pastOpen.toggle() } } label: {
                HStack {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .rotationEffect(.degrees(pastOpen ? 90 : 0))
                        .foregroundStyle(.secondary)
                    Text("Past Fields").font(.body.weight(.medium))
                    Spacer()
                    Text("\(pastFields.count)").foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .cardRow(first: true)
            if pastOpen {
                ForEach(pastGroups, id: \.key) { group in
                    HStack(spacing: 6) {
                        Text(group.name).font(.subheadline.weight(.semibold))
                        Text(group.deleted ? "Deleted list" : "Not on this list").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .cardRow()
                    ForEach(group.fields) { f in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(f.label).font(.caption).foregroundStyle(.secondary)
                                Text(pastValue(f)).textSelection(.enabled)
                            }
                            Spacer()
                            Button { Task { await store.saveField(id, fieldId: f.id, value: "") } } label: { Image(systemName: "xmark") }
                                .buttonStyle(RoundIconStyle())
                                .accessibilityLabel("Remove \(f.label)")
                        }
                        .cardRow()
                    }
                }
            }
        }
    }

    private func pastValue(_ f: FieldDef) -> String {
        let v = stored(f)
        switch f.type {
        case "checkbox": return "Yes"
        case "date": return FieldEditor.day.date(from: v)?.formatted(date: .abbreviated, time: .omitted) ?? v
        default: return v
        }
    }
}

/// Message, call or mail. With more than one number or address, a menu to pick one.
struct ActionButton: View {
    let title: String
    let icon: String
    let options: [Labeled]
    let link: (String) -> URL?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            if options.count > 1 {
                Menu {
                    ForEach(options) { o in
                        Button { if let u = link(o.value) { openURL(u) } } label: {
                            Text(o.value)
                            if !o.label.isEmpty { Text(o.label) }
                        }
                    }
                } label: { face }
            } else {
                Button { if let v = options.first?.value, let u = link(v) { openURL(u) } } label: { face }
                    .disabled(options.isEmpty)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(options) { o in
                Button { copyToClipboard(o.value) } label: { Label("Copy \(o.value)", systemImage: "doc.on.doc") }
            }
        }
    }

    private var face: some View { ActionFace(title: title, icon: icon, enabled: !options.isEmpty) }
}

struct ActionFace: View {
    let title: String
    let icon: String
    let enabled: Bool

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 18, weight: .medium))
            Text(title).font(.caption2.weight(.medium))
        }
        .foregroundStyle(enabled ? Color.accentColor : Color.secondary)
        .frame(maxWidth: .infinity, minHeight: 60)
        .softCard(radius: 16)
        .opacity(enabled ? 1 : 0.6)
    }
}

/// A labelled value. Tapping opens it (call, mail, map); long-press to copy.
struct ValueRow<Trailing: View, Extra: View>: View {
    let label: String
    let value: String
    let url: URL?
    var tinted = true
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var menu: () -> Extra
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack {
            if let url {
                Button { openURL(url) } label: { content }
                    .buttonStyle(.plain)
            } else {
                content
            }
            trailing()
        }
        .contextMenu {
            menu()
            Button { copyToClipboard(value) } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }
}

extension ValueRow {
    fileprivate var content: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .foregroundStyle(tinted && url != nil ? Color.accentColor : Color.primary)
                .multilineTextAlignment(.leading)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

extension ValueRow where Trailing == EmptyView, Extra == EmptyView {
    init(label: String, value: String, url: URL?, tinted: Bool = true) {
        self.init(label: label, value: value, url: url, tinted: tinted, trailing: { EmptyView() }, menu: { EmptyView() })
    }
}

/// One of your own fields, edited in place. Saves when you leave it or press return.
struct FieldEditor: View {
    let contactId: String
    let field: FieldDef
    let stored: String
    @Environment(Store.self) private var store
    @State private var text = ""
    @FocusState private var focused: Bool

    @State private var pickingDate = false
    @State private var pickedDate = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if field.type != "checkbox" {
                Text(field.label).font(.caption).foregroundStyle(.secondary)
            }
            switch field.type {
            case "checkbox":
                Toggle(isOn: Binding(get: { text == "1" }, set: { text = $0 ? "1" : ""; save() })) {
                    Text(field.label)
                }
                .toggleStyle(SoftToggleStyle())
            case "date": dateEditor
            case "longtext":
                TextField("Add", text: $text, axis: .vertical)
                    .lineLimit(1...10)
                    .focused($focused)
                    .fieldWell(focused: focused)
            default:
                TextField(field.type == "url" ? "https://" : "Add", text: $text)
                    .keyboardType(field.type == "url" ? .URL : .default)
                    .textInputAutocapitalization(field.type == "url" || field.key == "signal_username" ? .never : .sentences)
                    .autocorrectionDisabled(field.type == "url" || field.key == "signal_username")
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(save)
                    .fieldWell(focused: focused)
            }
        }
        .onAppear { text = stored }
        .onChange(of: stored) { _, v in if !focused { text = v } }
        .onChange(of: focused) { _, isFocused in if !isFocused { save() } }
    }

    /// The date in a well; tap for a calendar.
    private var dateEditor: some View {
        let date = Self.day.date(from: text)
        return Button {
            pickedDate = date ?? Date()
            pickingDate = true
        } label: {
            HStack {
                Text(date?.formatted(date: .abbreviated, time: .omitted) ?? "Add Date")
                    .foregroundStyle(date == nil ? Color.secondary : Color.primary)
                Spacer()
                Image(systemName: "calendar").foregroundStyle(.secondary)
            }
            .fieldWell()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(field.label): \(date?.formatted(date: .abbreviated, time: .omitted) ?? "empty")")
        .sheet(isPresented: $pickingDate) {
            VStack(spacing: 16) {
                HStack {
                    Button("Clear") { text = ""; save(); pickingDate = false }
                        .buttonStyle(TactileButtonStyle(compact: true))
                    Spacer()
                    Text(field.label).font(.headline)
                    Spacer()
                    Button("Done") { text = Self.day.string(from: pickedDate); save(); pickingDate = false }
                        .buttonStyle(TactileButtonStyle(kind: .primary, compact: true))
                }
                DatePicker(field.label, selection: $pickedDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .labelsHidden()
            }
            .padding(20)
            .presentationDetents([.medium])
            .presentationBackground { PaperBackground() }
        }
    }

    private func save() {
        guard text != stored else { return }
        let value = text
        Task { await store.saveField(contactId, fieldId: field.id, value: value) }
    }

    static let day: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}

/// The photo, full screen. Tap anywhere to close.
struct PhotoViewer: View {
    let url: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            AsyncImage(url: Photo.url(url, px: 1200)) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit()
                } else {
                    ProgressView().tint(.white)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(.white.opacity(0.18)))
            }
            .padding()
            .accessibilityLabel("Close")
        }
        .onTapGesture { dismiss() }
    }
}
