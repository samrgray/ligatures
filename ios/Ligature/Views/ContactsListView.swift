import SwiftUI

enum ListFilter: Hashable {
    case all
    case list(accountId: String, id: String)
}

struct ContactsListView: View {
    @Environment(Store.self) private var store
    @Environment(\.openURL) private var openURL
    @AppStorage("sortByFirst") private var sortByFirst = false
    @Namespace private var cardZoom
    /// Lists you’ve chosen to show with their sublists’ people (off by default), as “account|list” lines.
    @AppStorage("withSublists") private var withSublists = ""

    /// Views where you’ve hidden drafts (they show by default), as lines: “all” or “account|list”.
    @AppStorage("hiddenDrafts") private var hiddenDrafts = ""

    private func viewKey(_ f: ListFilter) -> String {
        if case let .list(accountId, id) = f { return "\(accountId)|\(id)" }
        return "all"
    }

    private func hidesDrafts(_ f: ListFilter) -> Bool {
        hiddenDrafts.split(separator: "\n").contains { $0 == viewKey(f) }
    }

    private func setHidesDrafts(_ f: ListFilter, _ hide: Bool) {
        var keys = hiddenDrafts.split(separator: "\n").map(String.init).filter { $0 != viewKey(f) }
        if hide { keys.append(viewKey(f)) }
        hiddenDrafts = keys.joined(separator: "\n")
    }

    /// Whether this view has drafts at all (shown or hidden).
    private func hasDrafts(_ f: ListFilter) -> Bool {
        store.contacts.contains { c in
            guard c.isDraft else { return false }
            if case let .list(accountId, id) = f { return c.accountId == accountId && c.groups.contains(id) }
            return true
        }
    }

    private func includesSublists(_ f: ListFilter) -> Bool {
        guard case let .list(accountId, id) = f else { return false }
        return withSublists.split(separator: "\n").contains { $0 == "\(accountId)|\(id)" }
    }

    private func setIncludesSublists(_ f: ListFilter, _ on: Bool) {
        guard case let .list(accountId, id) = f else { return }
        var keys = withSublists.split(separator: "\n").map(String.init).filter { $0 != "\(accountId)|\(id)" }
        if on { keys.append("\(accountId)|\(id)") }
        withSublists = keys.joined(separator: "\n")
    }
    @State private var query = ""
    @State private var filter: ListFilter = .all
    @State private var path: [String] = []
    /// The contact cards on top of the list, when open.
    @State private var opened: OpenedCards?

    private struct OpenedCards: Identifiable {
        let id = UUID()
        let start: String
        let order: [[String]]
    }

    /// Opens someone’s card over the list, with everyone in the list you’re viewing beside it.
    private func open(_ id: String) {
        opened = OpenedCards(start: id, order: entries(visible).map { $0.members.map(\.id) })
    }
    @State private var showNew = false
    @State private var showSettings = false
    @State private var showLists = false
    @State private var editMode: EditMode = .inactive
    @State private var selection = Set<String>()
    @State private var compose: ComposeTarget?
    @State private var bulkLists: ComposeTarget?
    @State private var tabDrag: TabDragState?
    @State private var chipFrames: [ListFilter: CGRect] = [:]
    @State private var stripPosition = ScrollPosition()
    @State private var stripOffset: CGFloat = 0
    @State private var stripViewport: CGFloat = 0
    @State private var stripContent: CGFloat = 0
    /// List, table or map.
    @AppStorage("layout") private var layout = "list"
    private var showMap: Bool {
        get { layout == "map" }
        nonmutating set { layout = newValue ? "map" : "list" }
    }
    private var showTable: Bool { layout == "table" }
    @State private var mapTypes: Set<String> = []
    @State private var mapSpot: MapSpot?
    @State private var addingPin = false
    @State private var openPin: Pin?
    @State private var showArchive = false

    private struct MapSpot: Identifiable {
        let id = UUID()
        let ids: [String]
    }

    /// A pinned tab being dragged. Positions are in the row’s own coordinates.
    private struct TabDragState {
        let ref: ListRef
        var order: [ListRef]
        let widths: [ListRef: CGFloat]
        /// Where the first pinned slot starts.
        let slotStart: CGFloat
        let startX: CGFloat
        let y: CGFloat
        var translation: CGFloat = 0
        /// How far the row has auto-scrolled since the drag began.
        var scrolled: CGFloat = 0
        var settling = false

        var x: CGFloat { startX + translation + scrolled }
        var width: CGFloat { widths[ref] ?? 0 }

        /// Left edge of each slot for an order.
        func slots(_ order: [ListRef]) -> [ListRef: CGFloat] {
            var out: [ListRef: CGFloat] = [:]
            var x = slotStart
            for r in order {
                out[r] = x
                x += (widths[r] ?? 0) + 8
            }
            return out
        }
    }

    private struct ComposeTarget: Identifiable {
        let id = UUID()
        let ids: [String]
    }

    private var selecting: Bool { editMode.isEditing }

    private var title: String {
        tabs.count > 1 ? "Contacts" : tabName(filter)
    }

    private func tabName(_ f: ListFilter) -> String {
        switch f {
        case .all: return filter == .all && tabs.count == 1 ? "Contacts" : "All"
        case let .list(accountId, id): return store.listName(id, accountId: accountId) ?? "List"
        }
    }

    /// All, your pinned lists, and the list you’re looking at if it isn’t pinned.
    private var tabs: [ListFilter] {
        let pinned = tabDrag?.order ?? store.pinnedLists.map { $0.ref }
        var out: [ListFilter] = [.all] + pinned.map { ListFilter.list(accountId: $0.accountId, id: $0.id) }
        if !out.contains(filter) { out.append(filter) }
        return out
    }

    private var visible: [ContactRow] { visible(for: filter) }

    private func visible(for filter: ListFilter) -> [ContactRow] {
        var items = store.contacts
        if case let .list(accountId, id) = filter {
            let ids = [id] + (includesSublists(filter) ? store.descendants(of: ListRef(accountId: accountId, id: id)) : [])
            items = items.filter { c in c.accountId == accountId && ids.contains { c.groups.contains($0) } }
        }
        if hidesDrafts(filter) { items = items.filter { !$0.isDraft } }
        let terms = query.lowercased().split(separator: " ").map(String.init)
        if !terms.isEmpty {
            items = items.filter { c in terms.allSatisfy { c.search.contains($0) } }
        }
        return items.sorted { $0.sortKey(byFirst: sortByFirst).localizedStandardCompare($1.sortKey(byFirst: sortByFirst)) == .orderedAscending }
    }

    /// A row of the list: one person, or people shown together.
    private struct Entry: Identifiable {
        let members: [ContactRow]
        var id: String { members[0].id }
        var lead: ContactRow { members[0] }
    }

    /// People shown together share one row wherever the first of them sorts. A list or search
    /// only shows the members it matches.
    private func entries(_ items: [ContactRow]) -> [Entry] {
        let groups = store.together
        guard !groups.isEmpty else { return items.map { Entry(members: [$0]) } }
        let shown = Set(items.map(\.id))
        var done = Set<String>()
        var out: [Entry] = []
        for c in items where !done.contains(c.id) {
            let members = (groups[c.id] ?? [c]).filter { shown.contains($0.id) }
            done.formUnion(members.map(\.id))
            out.append(Entry(members: members))
        }
        return out
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if showMap {
                    VStack(spacing: 0) {
                        if tabs.count > 1 { tabStrip }
                        mapPage
                    }
                } else {
                    VStack(spacing: 0) {
                        if tabs.count > 1 { tabStrip }
                        if showTable {
                            ContactsTable(items: visible, filter: filter) { open($0) }
                                .environment(\.cardZoomNamespace, cardZoom)
                                .id(filter)
                        } else {
                            page(filter)
                        }
                    }
                }
            }
            .background(PaperBackground())
            .environment(\.editMode, $editMode)
            .navigationTitle(selecting ? (selection.isEmpty ? "Select People" : "\(selectedIDs.count) Selected") : title)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
            .toolbar {
                if selecting {
                    ToolbarItem(placement: .topBarLeading) {
                        if showMap {
                            let ids = Set(mappedPoints.map(\.id))
                            let all = !ids.isEmpty && ids.isSubset(of: selection)
                            Button(all ? "Deselect All" : "Select All") {
                                selection = all ? [] : ids
                            }
                        } else {
                            let rows = entries(visible)
                            let all = !rows.isEmpty && rows.allSatisfy { selection.contains($0.id) }
                            Button(all ? "Deselect All" : "Select All") {
                                selection = all ? [] : Set(rows.map(\.id))
                            }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { endSelecting() }.bold()
                    }
                    ToolbarItemGroup(placement: .bottomBar) {
                        Button("Lists") { bulkLists = ComposeTarget(ids: selectedIDs) }
                            .disabled(selection.isEmpty)
                        Spacer()
                        Button("Archive") {
                            let ids = selectedIDs
                            Task {
                                await store.archive(.archive, ids: ids)
                                endSelecting()
                            }
                        }
                        .disabled(selection.isEmpty)
                        Spacer()
                        Button(selection.isEmpty ? "Message" : "Message \(selectedIDs.count)") { compose = ComposeTarget(ids: selectedIDs) }
                            .bold()
                            .disabled(selection.isEmpty)
                    }
                } else {
                    ToolbarItem(placement: .topBarLeading) { listsMenu }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("Layout", selection: Binding(get: { layout }, set: { v in withAnimation { layout = v } })) {
                                Label("List", systemImage: "list.bullet").tag("list")
                                Label("Table", systemImage: "tablecells").tag("table")
                                Label("Map", systemImage: "map").tag("map")
                            }
                        } label: {
                            Image(systemName: showMap ? "map" : showTable ? "tablecells" : "list.bullet")
                        }
                        .accessibilityLabel("Layout")
                    }
                    if !showTable {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Select") { withAnimation { editMode = .active } }
                                .disabled(store.contacts.isEmpty)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showNew = true } label: { Image(systemName: "plus") }
                            .accessibilityLabel("New Contact")
                            .disabled(store.accounts.isEmpty)
                    }
                }
            }
            .toolbar(selecting ? .visible : .hidden, for: .bottomBar)
        }
        .overlay {
            if let o = opened {
                PersonView(id: o.start, order: o.order, onClose: { opened = nil })
                    .id(o.id)
                    .environment(\.openPerson) { open($0) }
            }
        }
        .sheet(isPresented: $showNew) {
            // A new contact joins the list you’re viewing.
            if case let .list(accountId, id) = filter {
                ContactEditView(mode: .new, list: ListRef(accountId: accountId, id: id))
            } else {
                ContactEditView(mode: .new)
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showLists) { ManageListsView() }
        .sheet(isPresented: $showArchive) { ArchivedView() }
        .sheet(item: $compose) { t in
            ComposerView(ids: t.ids) { endSelecting() }
        }
        .sheet(item: $bulkLists) { t in
            let account = store.contacts.first { t.ids.contains($0.id) }?.accountId ?? ""
            ListPickerView(ids: t.ids.filter { id in store.contacts.contains { $0.id == id && $0.accountId == account } }, accountId: account)
        }
        .sheet(item: $mapSpot) { spot in
            MapPeopleSheet(ids: spot.ids, selection: $selection, selecting: selecting,
                           startSelecting: { withAnimation { editMode = .active } },
                           open: { id in
                               mapSpot = nil
                               open(id)
                           })
                .presentationDetents([.medium, .large])
        }
        .onAppear(perform: openDemoScreen)
    }

    /// One list of contacts: everyone, or one list.
    private func page(_ f: ListFilter) -> some View {
        let items = visible(for: f)
        // Rows are only selectable in Select mode; otherwise iOS treats a tap as selecting the
        // row instead of opening the contact.
        return List(selection: selecting ? $selection : nil) {
            ForEach(entries(items)) { e in
                let c = e.lead
                // While selecting, the tap goes to the row’s tick instead.
                Button { open(e.id) } label: {
                    HStack(spacing: 8) {
                        if e.members.count > 1 {
                            TogetherRowView(members: e.members)
                        } else {
                            ContactRowView(contact: c, sortByFirst: sortByFirst)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle())
                .disabled(selecting)
                .listRowBackground(Color.clear)
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if e.members.count == 1 && !c.phone.isEmpty {
                            Button { if let u = Links.tel(c.phone) { openURL(u) } } label: { Label("Call", systemImage: "phone.fill") }
                                .tint(.green)
                            Button { if let u = Links.sms(c.phone) { openURL(u) } } label: { Label("Message", systemImage: "message.fill") }
                                .tint(.blue)
                        }
                    }
                    .contextMenu {
                        if e.members.count > 1 {
                            ForEach(e.members) { m in
                                Menu(m.displayName.isEmpty ? "No Name" : m.displayName) { quickActions(m) }
                            }
                        } else {
                            quickActions(c)
                        }
                    }
            }
            if !items.isEmpty {
                Text("\(items.count) \(items.count == 1 ? "Contact" : "Contacts")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await store.refresh(sync: true) }
        .overlay {
            if items.isEmpty {
                if !query.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else if store.syncing {
                    ProgressView("Loading your contacts…")
                } else {
                    ContentUnavailableView(f == .all ? "No Contacts" : "No One in This List", systemImage: "person.crop.circle",
                                           description: Text(f == .all ? "Pull down to sync with Google." : "Add people from their contact card."))
                }
            }
        }
    }

    private var tabStrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(tabs, id: \.self) { t in
                        tabChip(t).id(t)
                    }
                }
                .coordinateSpace(name: "tabstrip")
                .onPreferenceChange(TabFrames.self) { chipFrames = $0 }
                // The tab you’re holding floats above the row and follows your finger exactly.
                .overlay(alignment: .topLeading) {
                    if let d = tabDrag, let t = tabs.first(where: { pinnedRef($0) == d.ref }) {
                        chipLabel(t)
                            // Tab fills are translucent; give the floating one a solid base.
                            .background(Capsule().fill(Theme.card))
                            .scaleEffect(d.settling ? 1 : 1.08)
                            .shadow(color: .black.opacity(d.settling ? 0 : 0.2), radius: 8, y: 3)
                            .offset(x: d.x, y: d.y)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .scrollPosition($stripPosition)
            .onScrollGeometryChange(for: [CGFloat].self) { g in
                [g.contentOffset.x, g.containerSize.width, g.contentSize.width]
            } action: { _, v in
                stripOffset = v[0]
                stripViewport = v[1]
                stripContent = v[2]
            }
            .scrollDisabled(tabDrag != nil)

            .onChange(of: filter) { _, f in
                guard tabDrag == nil else { return }
                withAnimation { proxy.scrollTo(f, anchor: .center) }
            }
        }
    }

    private func chipLabel(_ t: ListFilter) -> some View {
        let on = t == filter
        return Text(tabName(t))
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: 32)
            // Raised chips on the paper; the one you’re on is inked.
            .background(Capsule().fill(on ? Theme.ink : Theme.card))
            .overlay(Capsule().strokeBorder(on ? Color.clear : Theme.line, lineWidth: 0.5))
            .shadow(color: Theme.shadow.opacity(on ? 0.18 : 0.07), radius: on ? 4 : 2, y: 1)
            .foregroundStyle(on ? Theme.card : Color.primary)
    }

    /// One tab. Tap to show it; press, hold and drag a pinned one to move it.
    private func tabChip(_ t: ListFilter) -> some View {
        let ref = pinnedRef(t)
        let held = ref != nil && tabDrag?.ref == ref
        return chipLabel(t)
            // While held, its slot stays open in the row and the floating copy is drawn on top.
            .opacity(held ? 0 : 1)
            .background(GeometryReader { g in
                Color.clear.preference(key: TabFrames.self, value: [t: g.frame(in: .named("tabstrip"))])
            })
            .contentShape(Capsule())
            .onTapGesture { withAnimation(.snappy) { filter = t } }
            // Press and hold a pinned tab, then drag. This is UIKit’s long press, which works
            // with the row’s scrolling: a swipe scrolls, a still hold picks the tab up.
            .gesture(HoldToDrag(enabled: ref != nil) {
                if let r = ref { startTabDrag(r) }
            } changed: { dx in
                dragTab(to: dx)
            } ended: {
                endTabDrag()
            })
            .accessibilityAddTraits(t == filter ? [.isButton, .isSelected] : .isButton)
    }

    private func startTabDrag(_ ref: ListRef) {
        var widths: [ListRef: CGFloat] = [:]
        var firstSlot = CGFloat.greatestFiniteMagnitude
        for (t, f) in chipFrames {
            guard let r = pinnedRef(t) else { continue }
            widths[r] = f.width
            firstSlot = min(firstSlot, f.minX)
        }
        guard let me = chipFrames.first(where: { pinnedRef($0.key) == ref })?.value else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        withAnimation(.snappy(duration: 0.18)) {
            tabDrag = TabDragState(
                ref: ref, order: store.pinnedLists.map { $0.ref }, widths: widths,
                slotStart: firstSlot, startX: me.minX, y: me.minY
            )
        }
        Task { await autoScroll() }
    }

    private func dragTab(to dx: CGFloat) {
        guard var d = tabDrag, !d.settling else { return }
        d.translation = dx
        tabDrag = d
        reflowTabs()
    }

    /// Neighbours make room as soon as the held tab’s leading edge reaches their middle.
    private func reflowTabs() {
        guard var d = tabDrag else { return }
        var moved = false
        for _ in 0..<d.order.count {
            guard let i = d.order.firstIndex(of: d.ref) else { break }
            let pos = d.slots(d.order)
            if i + 1 < d.order.count {
                let n = d.order[i + 1]
                if d.x + d.width > (pos[n] ?? 0) + (d.widths[n] ?? 0) / 2 {
                    d.order.swapAt(i, i + 1)
                    moved = true
                    continue
                }
            }
            if i > 0 {
                let p = d.order[i - 1]
                if d.x < (pos[p] ?? 0) + (d.widths[p] ?? 0) / 2 {
                    d.order.swapAt(i, i - 1)
                    moved = true
                    continue
                }
            }
            break
        }
        if moved {
            UISelectionFeedbackGenerator().selectionChanged()
            withAnimation(.snappy(duration: 0.22)) { tabDrag = d }
        }
    }

    /// Scrolls the row while the held tab is near either edge.
    private func autoScroll() async {
        while let d = tabDrag, !d.settling {
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard var d = tabDrag, !d.settling, stripViewport > 0 else { continue }
            let edge: CGFloat = 44
            let left = d.x + 16 - stripOffset // 16: the row’s side padding
            let right = left + d.width
            var step: CGFloat = 0
            if right > stripViewport - edge { step = min(10, (right - (stripViewport - edge)) / 4 + 2) }
            if left < edge { step = -min(10, (edge - left) / 4 + 2) }
            let maxOffset = max(0, stripContent - stripViewport)
            let next = min(max(stripOffset + step, 0), maxOffset)
            let delta = next - stripOffset
            guard abs(delta) > 0.5 else { continue }
            stripOffset = next
            stripPosition.scrollTo(x: next)
            d.scrolled += delta
            tabDrag = d
            reflowTabs()
        }
    }

    /// Let go: the held tab settles into its slot, then the order is saved.
    private func endTabDrag() {
        guard var d = tabDrag, !d.settling else { return }
        let target = d.slots(d.order)[d.ref] ?? d.startX
        d.settling = true
        d.translation = target - d.startX - d.scrolled
        withAnimation(.snappy(duration: 0.2)) { tabDrag = d }
        let order = d.order
        let changed = order != store.pinnedLists.map { $0.ref }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            if changed { store.pinned = order }
            tabDrag = nil
            if changed { Task { await store.savePinnedOrder() } }
        }
    }

    private func pinnedRef(_ t: ListFilter) -> ListRef? {
        guard case let .list(accountId, id) = t else { return nil }
        let r = ListRef(accountId: accountId, id: id)
        return store.pinned.contains(r) ? r : nil
    }

    private var listsMenu: some View {
        Menu {
            Picker("Show", selection: $filter) {
                Text("All Contacts").tag(ListFilter.all)
                ForEach(store.accounts) { a in
                    ForEach(store.tree(store.orderedLists.filter { $0.ref.accountId == a.id }), id: \.entry.ref) { item in
                        let g = item.entry.list
                        let indent = String(repeating: "\u{2003}", count: item.depth)
                        Text(indent + (store.accounts.count > 1 ? "\(g.name) · \(a.label ?? a.providerName)" : g.name))
                            .tag(ListFilter.list(accountId: a.id, id: g.id))
                    }
                }
            }
            if hasDrafts(filter) {
                Toggle("Show Drafts", isOn: Binding(get: { !hidesDrafts(filter) }, set: { setHidesDrafts(filter, !$0) }))
            }
            if case let .list(accountId, id) = filter, !store.descendants(of: ListRef(accountId: accountId, id: id)).isEmpty {
                Toggle("Include Sublists", isOn: Binding(
                    get: { includesSublists(filter) },
                    set: { on in setIncludesSublists(filter, on) }
                ))
            }
            Divider()
            Button { compose = ComposeTarget(ids: visible.map(\.id)) } label: {
                Label(filter == .all ? "Message Everyone…" : "Message Everyone in \(title)…", systemImage: "paperplane")
            }
            .disabled(visible.isEmpty)
            Button { showLists = true } label: { Label("Manage Lists…", systemImage: "list.bullet") }
            Button { showArchive = true } label: {
                Label(store.archived.isEmpty ? "Archived" : "Archived (\(store.archived.count))", systemImage: "archivebox")
            }
            Button { showSettings = true } label: { Label("Settings…", systemImage: "gearshape") }
        } label: {
            Text("Lists")
        }
    }

    @ViewBuilder
    private func quickActions(_ c: ContactRow) -> some View {
        if !c.phone.isEmpty {
            Button { if let u = Links.tel(c.phone) { openURL(u) } } label: { Label("Call", systemImage: "phone") }
            Button { if let u = Links.sms(c.phone) { openURL(u) } } label: { Label("Message", systemImage: "message") }
            Button { copyToClipboard(c.phone) } label: { Label("Copy \(c.phone)", systemImage: "doc.on.doc") }
        }
        if !c.email.isEmpty {
            Button { if let u = Links.mail(c.email) { openURL(u) } } label: { Label("Email", systemImage: "envelope") }
            Button { copyToClipboard(c.email) } label: { Label("Copy \(c.email)", systemImage: "doc.on.doc") }
        }
    }

    /// Selected people in the order they’re shown.
    /// Everyone ticked: whole rows from the list, or single people from the map.
    private var selectedIDs: [String] {
        var seen = Set<String>()
        return entries(visible).flatMap { e in
            e.members.filter { selection.contains(e.id) || selection.contains($0.id) }.map(\.id)
        }
        .filter { seen.insert($0).inserted }
    }

    // MARK: Map

    /// Points for the people shown, before filtering by address type.
    private var mappedAll: [MapPoint] {
        let ids = Set(visible.map(\.id))
        return store.mapPoints.filter { ids.contains($0.id) }
    }

    private var mappedPoints: [MapPoint] {
        mappedAll.filter { mapTypes.isEmpty || mapTypes.contains($0.type) }
    }

    private var mapPage: some View {
        let people = visible
        let all = mappedAll
        let order = ["home", "work", "other"]
        let types = Set(all.map(\.type)).sorted {
            let a = order.firstIndex(of: $0) ?? 9, b = order.firstIndex(of: $1) ?? 9
            return a != b ? a < b : $0 < $1
        }
        let shown = mappedPoints
        let frameKey = people.map(\.id).joined(separator: ",") + "|" + mapTypes.sorted().joined(separator: ",")
        return PeopleMapView(people: people, points: shown, selected: Set(selectedIDs), pins: store.pins,
                             onPin: { openPin = $0 }, frameKey: frameKey,
                             onTap: { ids in
                                 // In Select mode a tap ticks the person; otherwise it shows who it is.
                                 if selecting, ids.count == 1, let id = ids.first {
                                     if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
                                 } else {
                                     mapSpot = MapSpot(ids: ids)
                                 }
                             })
        .ignoresSafeArea(edges: .bottom)
        .overlay(alignment: .top) {
            if types.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        typeChip("All", on: mapTypes.isEmpty) { mapTypes = [] }
                        ForEach(types, id: \.self) { t in
                            typeChip(t.capitalized, on: mapTypes.contains(t)) {
                                if mapTypes.contains(t) { mapTypes.remove(t) } else { mapTypes.insert(t) }
                            }
                            .accessibilityIdentifier("map-type-\(t)")
                        }
                    }
                    .padding(.leading)
                    .padding(.trailing, 64)
                    .padding(.vertical, 8)
                }
            }
        }
        .overlay(alignment: .bottomLeading) {
            Text(mapStatus(people: people, shown: shown))
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                .padding(.leading, 12)
                .padding(.bottom, selecting ? 8 : 40)
        }
        .overlay(alignment: .topTrailing) {
            Button { addingPin = true } label: {
                Image(systemName: "mappin.and.ellipse")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color(.systemBackground)))
                    .shadow(color: .black.opacity(0.15), radius: 3, y: 1)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add Pin")
            .padding(.trailing, 12)
            .padding(.top, 8)
        }
        .sheet(isPresented: $addingPin) { AddPinSheet().presentationDetents([.medium, .large]) }
        .sheet(item: $openPin) { PinSheet(pin: $0).presentationDetents([.medium]) }
        .task(id: store.contacts.hashValue) { await store.loadMap { showMap } }
        .task { await store.loadPins() }
    }

    private func typeChip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background(Capsule().fill(on ? Color.accentColor : Color(.systemBackground)))
                .foregroundStyle(on ? Color.white : Color.primary)
                .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
        }
        .buttonStyle(.plain)
    }

    private func mapStatus(people: [ContactRow], shown: [MapPoint]) -> String {
        if !store.mapLoaded { return "Loading…" }
        let onMap = Set(shown.map(\.id)).count
        let placed = Set(store.mapPoints.map(\.id))
        var parts = ["\(onMap) \(onMap == 1 ? "person" : "people") on the map"]
        let without = people.filter { !placed.contains($0.id) && !store.mapFailed.contains($0.id) }.count
        if without > 0, store.mapPending == 0 { parts.append("\(without) without an address") }
        let notFound = people.filter { store.mapFailed.contains($0.id) && !placed.contains($0.id) }.count
        if notFound > 0 { parts.append("\(notFound) not found") }
        if store.mapStalled { parts.append("OpenStreetMap isn’t answering") }
        else if store.mapPending > 0 { parts.append("Finding \(store.mapPending) \(store.mapPending == 1 ? "place" : "places")…") }
        return parts.joined(separator: " · ")
    }

    private func endSelecting() {
        withAnimation {
            editMode = .inactive
            selection = []
        }
    }

    private func openDemoScreen() {
        // Demo runs start on the list unless they ask for the map.
        if store.demo { layout = store.demoScreen == "table" ? "table" : ["map", "mapspot"].contains(store.demoScreen ?? "") ? "map" : "list" }
        guard store.demo, opened == nil, let screen = store.demoScreen else { return }
        let ava = store.contacts.first { $0.givenName == "Ava" }?.id ?? store.contacts.first?.id
        switch screen {
        case "detail", "edit", "lists", "fields": if let ava { open(ava) }
        case "together", "relate": open("demo-0")
        case "select":
            editMode = .active
            selection = Set(entries(visible).prefix(5).map(\.id).enumerated().filter { $0.offset != 2 }.map(\.element))
        case "compose", "review":
            compose = ComposeTarget(ids: visible.prefix(6).map(\.id))
        case "tab": filter = .list(accountId: "demo", id: "contactGroups/book")
        case "tabdrag":
            // A drag frozen part-way, for checking how it looks.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                startTabDrag(ListRef(accountId: "demo", id: "contactGroups/starred"))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { dragTab(to: 70) }
            }
        case "map": showMap = true
        case "mapspot":
            showMap = true
            let hood = store.mapPoints.filter { $0.precision == "neighborhood" }.map(\.id)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { mapSpot = MapSpot(ids: hood) }
        case "search": query = "ch"
        case "manage": showLists = true
        case "settings": showSettings = true
        default: break
        }
    }
}

/// People shown together: overlapping photos and “Alex & Jamie Smith”.
struct TogetherRowView: View {
    let members: [ContactRow]

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                ForEach(Array(members.prefix(2).enumerated()), id: \.element.id) { i, m in
                    Avatar(url: m.photoUrl, initials: m.initials, size: 26)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                        .offset(x: i == 0 ? -6 : 6, y: i == 0 ? -6 : 6)
                }
            }
            .frame(width: 36, height: 36)
            Text(Together.name(members))
                .fontWeight(.semibold)
                .lineLimit(1)
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
    }
}

/// Marks a contact that’s only in Ligature.
/// A row you tap to open: no styling of its own, just a light press.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.6 : 1)
    }
}

struct DraftTag: View {
    var body: some View {
        Text("Draft")
            .font(.caption2.weight(.medium))
            .foregroundStyle(Theme.brand)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().strokeBorder(Theme.brand, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
            .accessibilityLabel("Draft, only in Ligature")
            .accessibilityIdentifier("draft-tag")
    }
}

struct ContactRowView: View {
    let contact: ContactRow
    let sortByFirst: Bool

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: contact.photoUrl, initials: contact.initials, size: 36)
                .overlay {
                    if contact.isDraft {
                        Circle().strokeBorder(Theme.brand, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2.5])).padding(-3)
                    }
                }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    name.italic(contact.isDraft)
                    if contact.isDraft { DraftTag() }
                }
                if !contact.organization.isEmpty, !contact.givenName.isEmpty || !contact.familyName.isEmpty {
                    Text(contact.organization)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 1)
    }

    /// The part you sort by is bold, like in Contacts.
    private var name: Text {
        let first = contact.givenName
        let last = contact.familyName
        if first.isEmpty && last.isEmpty { return Text(contact.displayName.isEmpty ? "No Name" : contact.displayName).bold() }
        if first.isEmpty { return Text(last).bold() }
        if last.isEmpty { return Text(first).bold() }
        return sortByFirst ? Text(first).bold() + Text(" \(last)") : Text("\(first) ") + Text(last).bold()
    }
}

private struct TabFrames: PreferenceKey {
    static var defaultValue: [ListFilter: CGRect] = [:]
    static func reduce(value: inout [ListFilter: CGRect], nextValue: () -> [ListFilter: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

/// Press and hold, then drag: UIKit’s long-press recognizer, which keeps reporting as the finger
/// moves after it fires. Unlike a SwiftUI drag gesture, it doesn’t stop a scroll view scrolling.
private struct HoldToDrag: UIGestureRecognizerRepresentable {
    let enabled: Bool
    let began: () -> Void
    let changed: (CGFloat) -> Void
    let ended: () -> Void

    init(enabled: Bool, began: @escaping () -> Void, changed: @escaping (CGFloat) -> Void, ended: @escaping () -> Void) {
        self.enabled = enabled
        self.began = began
        self.changed = changed
        self.ended = ended
    }

    final class Recognizer: UILongPressGestureRecognizer {
        var startX: CGFloat = 0
    }

    func makeUIGestureRecognizer(context: Context) -> Recognizer {
        let g = Recognizer()
        g.minimumPressDuration = 0.3
        g.allowableMovement = 10
        g.isEnabled = enabled
        return g
    }

    func updateUIGestureRecognizer(_ g: Recognizer, context: Context) {
        g.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ g: Recognizer, context: Context) {
        let x = g.location(in: nil).x
        switch g.state {
        case .began:
            g.startX = x
            began()
        case .changed:
            changed(x - g.startX)
        case .ended, .cancelled, .failed:
            ended()
        default:
            break
        }
    }
}
