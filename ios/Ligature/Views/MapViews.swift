import MapLibre
import SwiftUI

// The map: everyone in the list you’re viewing, at each of their addresses. Vector OpenStreetMap
// tiles from OpenFreeMap, drawn with MapLibre. Mirrors public/map.js on the web.

private enum MapStyle {
    static let light = URL(string: "https://tiles.openfreemap.org/styles/positron")!
    static let dark = URL(string: "https://tiles.openfreemap.org/styles/dark")!
    static let font = ["Noto Sans Bold"]
}

struct PeopleMapView: UIViewRepresentable {
    /// The people shown, and their points (already filtered by address type).
    let people: [ContactRow]
    let points: [MapPoint]
    let selected: Set<String>
    let pins: [Pin]
    /// Tapped one of your pins.
    var onPin: (Pin) -> Void = { _ in }
    /// Changes when the list or address types change, to reframe the map.
    let frameKey: String
    /// Tapped someone: the people there.
    let onTap: ([String]) -> Void
    @Environment(\.colorScheme) private var scheme

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero, styleURL: scheme == .dark ? MapStyle.dark : MapStyle.light)
        map.delegate = context.coordinator
        map.allowsRotating = false
        map.allowsTilting = false
        map.setCenter(CLLocationCoordinate2D(latitude: 39.8, longitude: -98.6), zoomLevel: 3, animated: false)
        map.accessibilityIdentifier = "people-map"
        context.coordinator.map = map
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        let c = context.coordinator
        c.parent = self
        let url = scheme == .dark ? MapStyle.dark : MapStyle.light
        if map.styleURL != url { map.styleURL = url }
        c.refresh()
    }

    final class Coordinator: NSObject, MLNMapViewDelegate {
        var parent: PeopleMapView
        weak var map: MLNMapView?
        var framedFor: String?
        var framedCount = 0
        var userMoved = false
        private var faces: [String: FaceAnnotation] = [:]
        private var pinMarks: [String: PinAnnotation] = [:]
        private var offsets: [String: CGVector] = [:]
        private var grouped: Set<String> = []
        private var laidOutZoom: Double = -1

        init(_ parent: PeopleMapView) { self.parent = parent }

        func mapView(_ mapView: MLNMapView, regionWillChangeWith reason: MLNCameraChangeReason, animated: Bool) {
            if reason.contains(.gesturePan) || reason.contains(.gesturePinch) || reason.contains(.gestureZoomIn)
                || reason.contains(.gestureZoomOut) {
                userMoved = true
            }
        }

        func mapViewRegionIsChanging(_ mapView: MLNMapView) {
            if abs(mapView.zoomLevel - laidOutZoom) > 0.05 { layout() }
        }

        func mapView(_ mapView: MLNMapView, regionDidChangeAnimated animated: Bool) {
            if abs(mapView.zoomLevel - laidOutZoom) > 0.001 { layout() }
        }

        /// Bring the markers in line with the people, pins and selection.
        func refresh() {
            guard let map else { return }
            let people = Dictionary(parent.people.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            var keep = Set<String>()
            var added: [MLNAnnotation] = []
            for p in parent.points {
                guard let c = people[p.id] else { continue }
                let key = "\(p.id)|\(p.lat)|\(p.lng)|\(p.label)"
                keep.insert(key)
                let a = faces[key] ?? {
                    let a = FaceAnnotation()
                    a.key = key
                    a.coordinate = CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng)
                    faces[key] = a
                    added.append(a)
                    return a
                }()
                a.personId = p.id
                a.name = c.displayName.isEmpty ? "No Name" : c.displayName
                a.initials = c.initials
                a.photo = c.photoUrl
                a.exact = p.precision == "address"
                a.selected = parent.selected.contains(p.id)
                a.title = a.name
            }
            let gone = faces.filter { !keep.contains($0.key) }
            for (k, _) in gone { faces[k] = nil }
            map.removeAnnotations(gone.map(\.value))

            var keepPins = Set<String>()
            var gonePins: [MLNAnnotation] = []
            for pin in parent.pins {
                keepPins.insert(pin.id)
                if let a = pinMarks[pin.id] {
                    a.pin = pin
                } else {
                    let a = PinAnnotation()
                    a.pin = pin
                    a.coordinate = CLLocationCoordinate2D(latitude: pin.lat, longitude: pin.lng)
                    pinMarks[pin.id] = a
                    added.append(a)
                }
            }
            for (id, a) in pinMarks where !keepPins.contains(id) {
                gonePins.append(a)
                pinMarks[id] = nil
            }
            map.removeAnnotations(gonePins)
            if !added.isEmpty { map.addAnnotations(added) }
            for a in faces.values { (map.view(for: a) as? FaceView)?.configure(a) }
            for a in pinMarks.values { (map.view(for: a) as? PinView)?.configure(a.pin) }

            let coords = faces.values.map(\.coordinate)
            if parent.frameKey != framedFor { userMoved = false }
            if !coords.isEmpty, parent.frameKey != framedFor || (!userMoved && coords.count != framedCount) {
                framedFor = parent.frameKey
                framedCount = coords.count
                frame(map, coords)
            }
            layout()
        }

        /// Spread out faces that overlap so everyone shows.
        func layout() {
            guard let map else { return }
            laidOutZoom = map.zoomLevel
            let list = Array(faces.values)
            let pts = list.map { map.convert($0.coordinate, toPointTo: map) }
            let result = Spread.offsets(pts, d: FaceView.size + 4)
            offsets = [:]
            grouped = []
            for (i, a) in list.enumerated() {
                offsets[a.key] = result[i].offset
                if result[i].grouped { grouped.insert(a.key) }
                if let v = map.view(for: a) as? FaceView {
                    v.centerOffset = result[i].offset
                    v.layer.zPosition = result[i].grouped ? 1 : 0
                }
            }
        }

        private func frame(_ map: MLNMapView, _ coords: [CLLocationCoordinate2D]) {
            guard let first = coords.first else { return }
            var sw = first, ne = first
            for c in coords {
                sw.latitude = min(sw.latitude, c.latitude); sw.longitude = min(sw.longitude, c.longitude)
                ne.latitude = max(ne.latitude, c.latitude); ne.longitude = max(ne.longitude, c.longitude)
            }
            if abs(ne.latitude - sw.latitude) < 0.01, abs(ne.longitude - sw.longitude) < 0.01 {
                map.setCenter(first, zoomLevel: 13, animated: false)
                return
            }
            let camera = map.cameraThatFitsCoordinateBounds(MLNCoordinateBounds(sw: sw, ne: ne),
                                                            edgePadding: UIEdgeInsets(top: 80, left: 50, bottom: 70, right: 50))
            map.setCamera(camera, animated: false)
            if map.zoomLevel > 13 { map.setZoomLevel(13, animated: false) }
        }

        func mapView(_ mapView: MLNMapView, viewFor annotation: MLNAnnotation) -> MLNAnnotationView? {
            if let a = annotation as? FaceAnnotation {
                let v = mapView.dequeueReusableAnnotationView(withIdentifier: "face") as? FaceView ?? FaceView(reuseIdentifier: "face")
                v.configure(a)
                v.centerOffset = offsets[a.key] ?? .zero
                v.layer.zPosition = grouped.contains(a.key) ? 1 : 0
                return v
            }
            if let a = annotation as? PinAnnotation {
                let v = mapView.dequeueReusableAnnotationView(withIdentifier: "pin") as? PinView ?? PinView(reuseIdentifier: "pin")
                v.configure(a.pin)
                return v
            }
            return nil
        }

        func mapView(_ mapView: MLNMapView, annotationCanShowCallout annotation: MLNAnnotation) -> Bool { false }

        func mapView(_ mapView: MLNMapView, didSelect annotation: MLNAnnotation) {
            mapView.deselectAnnotation(annotation, animated: false)
            if let a = annotation as? FaceAnnotation { parent.onTap([a.personId]) }
            if let a = annotation as? PinAnnotation { parent.onPin(a.pin) }
        }
    }
}

final class FaceAnnotation: MLNPointAnnotation {
    var key = ""
    var personId = ""
    var name = ""
    var initials = ""
    var photo = ""
    var exact = false
    var selected = false
}

final class PinAnnotation: MLNPointAnnotation {
    var pin: Pin!
}

/// A person on the map: their photo, or initials, in a ring. Solid for a street address,
/// dashed for a city or neighborhood.
final class FaceView: MLNAnnotationView {
    static let size: CGFloat = 36
    private static let cache = NSCache<NSString, UIImage>()
    private let disc = UIView()
    private let initials = UILabel()
    private let photo = UIImageView()
    private let dashes = CAShapeLayer()
    private let badge = UIView()
    private var photoURL: URL?

    override init(reuseIdentifier: String?) {
        super.init(reuseIdentifier: reuseIdentifier)
        let s = Self.size
        frame = CGRect(x: 0, y: 0, width: s, height: s)
        scalesWithViewingDistance = false
        disc.frame = bounds
        disc.layer.cornerRadius = s / 2
        disc.clipsToBounds = true
        addSubview(disc)
        initials.frame = disc.bounds
        initials.textAlignment = .center
        initials.font = .systemFont(ofSize: 12, weight: .bold)
        disc.addSubview(initials)
        photo.frame = disc.bounds
        photo.contentMode = .scaleAspectFill
        disc.addSubview(photo)
        dashes.path = UIBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1)).cgPath
        dashes.fillColor = UIColor.clear.cgColor
        dashes.lineWidth = 2
        layer.addSublayer(dashes)
        badge.frame = CGRect(x: s - 12, y: s - 12, width: 13, height: 13)
        badge.layer.cornerRadius = 6.5
        badge.layer.borderWidth = 2
        addSubview(badge)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.25
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ a: FaceAnnotation) {
        let accent = UIColor(named: "AccentColor") ?? .systemBlue
        let bg = UIColor.systemBackground
        accessibilityLabel = a.name
        initials.text = a.initials
        let hasPhoto = !a.photo.isEmpty
        disc.backgroundColor = a.exact && !hasPhoto ? accent : bg
        initials.textColor = a.exact && !hasPhoto ? .white : accent
        // Solid ring for a street address, dashed for a city or neighborhood.
        dashes.strokeColor = (a.selected ? UIColor.label : (a.exact ? bg : accent)).resolvedColor(with: traitCollection).cgColor
        dashes.lineWidth = a.selected ? 3 : 2
        dashes.lineDashPattern = a.exact || a.selected ? nil : [4, 3]
        badge.isHidden = !a.selected
        badge.backgroundColor = accent
        badge.layer.borderColor = bg.resolvedColor(with: traitCollection).cgColor
        loadPhoto(a.photo)
    }

    private func loadPhoto(_ raw: String) {
        let url = Photo.url(raw, px: 108)
        if url == photoURL { return }
        photoURL = url
        photo.image = nil
        guard let url else { return }
        if let img = Self.cache.object(forKey: url.absoluteString as NSString) {
            photo.image = img
            return
        }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let img = UIImage(data: data) else { return }
            Self.cache.setObject(img, forKey: url.absoluteString as NSString)
            DispatchQueue.main.async {
                guard let self, self.photoURL == url else { return }
                self.photo.image = img
            }
        }.resume()
    }
}

/// One of your pins: a red dot with its label underneath.
final class PinView: MLNAnnotationView {
    private let dot = UIView()
    private let label = PaddedLabel()

    override init(reuseIdentifier: String?) {
        super.init(reuseIdentifier: reuseIdentifier)
        frame = CGRect(x: 0, y: 0, width: 22, height: 22)
        scalesWithViewingDistance = false
        dot.frame = bounds
        dot.backgroundColor = .systemRed
        dot.layer.cornerRadius = 11
        dot.layer.borderWidth = 3
        dot.layer.borderColor = UIColor.white.cgColor
        addSubview(dot)
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .label
        label.backgroundColor = .systemBackground
        label.layer.cornerRadius = 5
        label.clipsToBounds = true
        addSubview(label)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.25
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)
        layer.zPosition = 2
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ pin: Pin) {
        label.text = pin.label
        accessibilityLabel = "Pin: \(pin.label)"
        let size = label.intrinsicContentSize
        label.frame = CGRect(x: (bounds.width - size.width) / 2, y: bounds.height + 3, width: size.width, height: size.height)
    }
}

final class PaddedLabel: UILabel {
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: min(s.width + 10, 180), height: s.height + 4)
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 5, dy: 2))
    }
}

/// Spread overlapping markers apart: markers closer than `d` join a group (and groups whose
/// spread would touch join too), laid out as a honeycomb around the group’s middle with each
/// marker in the cell nearest its real position. Mirrors spread() in public/map.js.
enum Spread {
    static func offsets(_ pts: [CGPoint], d: CGFloat) -> [(offset: CGVector, grouped: Bool)] {
        func rings(_ n: Int) -> Int {
            var k = 0
            while 1 + 3 * k * (k + 1) < n { k += 1 }
            return k
        }
        struct Group { var members: [Int]; var x: CGFloat; var y: CGFloat; var r: CGFloat }
        var groups = pts.enumerated().map { Group(members: [$0.offset], x: $0.element.x, y: $0.element.y, r: 0) }
        for _ in 0..<12 {
            groups.sort { $0.x < $1.x }
            let maxR = groups.map(\.r).max() ?? 0
            var gone = Set<Int>()
            var merged = false
            for i in groups.indices where !gone.contains(i) {
                var j = i + 1
                while j < groups.count {
                    if groups[j].x - groups[i].x > groups[i].r + maxR + d { break }
                    if !gone.contains(j), hypot(groups[i].x - groups[j].x, groups[i].y - groups[j].y) < groups[i].r + groups[j].r + d * 0.98 {
                        groups[i].members += groups[j].members
                        let n = CGFloat(groups[i].members.count)
                        groups[i].x = groups[i].members.reduce(0) { $0 + pts[$1].x } / n
                        groups[i].y = groups[i].members.reduce(0) { $0 + pts[$1].y } / n
                        groups[i].r = CGFloat(rings(groups[i].members.count)) * d
                        gone.insert(j)
                        merged = true
                    }
                    j += 1
                }
            }
            groups = groups.enumerated().filter { !gone.contains($0.offset) }.map(\.element)
            if !merged { break }
        }
        var out = Array(repeating: (offset: CGVector.zero, grouped: false), count: pts.count)
        for g in groups where g.members.count > 1 {
            let k = rings(g.members.count)
            var slots: [CGPoint] = []
            for q in -k...k {
                for r in max(-k, -q - k)...min(k, -q + k) {
                    slots.append(CGPoint(x: d * (CGFloat(q) + CGFloat(r) / 2), y: d * CGFloat(r) * sqrt(3) / 2))
                }
            }
            slots.sort {
                let a = hypot($0.x, $0.y), b = hypot($1.x, $1.y)
                return abs(a - b) > 0.01 ? a < b : atan2($0.y, $0.x) < atan2($1.y, $1.x)
            }
            var left = Set(g.members)
            for s in slots.prefix(g.members.count) {
                let target = CGPoint(x: g.x + s.x, y: g.y + s.y)
                guard let best = left.min(by: { hypot(pts[$0].x - target.x, pts[$0].y - target.y) < hypot(pts[$1].x - target.x, pts[$1].y - target.y) }) else { break }
                left.remove(best)
                out[best] = (CGVector(dx: target.x - pts[best].x, dy: target.y - pts[best].y), true)
            }
        }
        return out
    }
}

/// The people at a spot on the map: tick to select, tap a name to open them.
struct MapPeopleSheet: View {
    let ids: [String]
    @Binding var selection: Set<String>
    let selecting: Bool
    let startSelecting: () -> Void
    let open: (String) -> Void
    @Environment(Store.self) private var store

    var body: some View {
        let people = ids.compactMap { id in store.contacts.first { $0.id == id } }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
        let all = people.allSatisfy { selection.contains($0.id) }
        NavigationStack {
            List(people) { c in
                let on = selection.contains(c.id)
                let where_ = store.mapPoints.filter { $0.id == c.id }.map { p in
                    [p.type, p.text].filter { !$0.isEmpty }.joined(separator: " · ")
                }
                HStack(spacing: 12) {
                    Button { toggle([c.id], !on) } label: {
                        Image(systemName: on ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(on ? Color.accentColor : Color(.tertiaryLabel))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(on ? "Deselect \(c.displayName)" : "Select \(c.displayName)")
                    Button { open(c.id) } label: {
                        HStack(spacing: 10) {
                            Avatar(url: c.photoUrl, initials: c.initials, size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.displayName.isEmpty ? "No Name" : c.displayName).foregroundStyle(Color.primary)
                                Text(where_.joined(separator: "\n")).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color(.tertiaryLabel))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .navigationTitle(people.count == 1 ? "1 Person" : "\(people.count) People")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if people.count > 1 {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(all ? "Deselect All" : "Select All") { toggle(people.map(\.id), !all) }
                    }
                }
            }
        }
    }

    private func toggle(_ ids: [String], _ on: Bool) {
        if on, !selecting { startSelecting() }
        for id in ids {
            if on { selection.insert(id) } else { selection.remove(id) }
        }
    }
}

/// Find a place and pin it with a label.
struct AddPinSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Place]?
    @State private var searching = false
    @State private var error: String?
    @State private var picked: Place?
    @State private var label = ""
    @State private var saving = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let picked {
                    Section {
                        TextField("Label", text: $label)
                    } footer: {
                        Text(picked.address)
                    }
                } else {
                    Section {
                        HStack {
                            TextField("Search for an address or place", text: $query)
                                .focused($searchFocused)
                                .submitLabel(.search)
                                .onSubmit(search)
                                .autocorrectionDisabled()
                            if searching { ProgressView() }
                        }
                    } footer: {
                        if let error { Text(error) }
                    }
                    if let results {
                        Section {
                            if results.isEmpty { Text("No places found.").foregroundStyle(.secondary) }
                            ForEach(results) { r in
                                Button {
                                    picked = r
                                    label = r.name
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(r.name).foregroundStyle(Color.primary)
                                        Text(r.address).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(picked == nil ? "Add Pin" : "Label Pin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if picked != nil { Button("Back") { picked = nil } } else { Button("Cancel") { dismiss() } }
                }
                if let picked {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") {
                            saving = true
                            Task {
                                let ok = await store.addPin(picked, label: label.trimmingCharacters(in: .whitespaces))
                                saving = false
                                if ok { dismiss() }
                            }
                        }
                        .bold()
                        .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                    }
                }
            }
            .onAppear { searchFocused = true }
        }
    }

    private func search() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3, !searching else { return }
        searching = true
        error = nil
        Task {
            do {
                results = try await store.searchPlaces(q)
            } catch {
                self.error = error.localizedDescription
            }
            searching = false
        }
    }
}

/// One of your pins: rename or remove it.
struct PinSheet: View {
    let pin: Pin
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Label", text: $label)
                } footer: {
                    if !pin.address.isEmpty { Text(pin.address) }
                }
                Section {
                    Button("Remove Pin", role: .destructive) {
                        Task {
                            await store.removePin(pin)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("Pin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let l = label.trimmingCharacters(in: .whitespaces)
                        Task {
                            if l != pin.label { await store.renamePin(pin, to: l) }
                            dismiss()
                        }
                    }
                    .bold()
                    .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { label = pin.label }
        }
    }
}

/// A faint map behind a contact’s photo and name, with their place centred vertically and three
/// quarters of the way across. Only to look at: touches go through to the card.
struct HeaderMap: View {
    let point: MapPoint

    var body: some View {
        GeometryReader { g in
            // A map half as wide again, from the left edge: its centre is three quarters across.
            HeaderMapView(point: point)
                .frame(width: g.size.width * 1.5, height: g.size.height)
                .frame(width: g.size.width, height: g.size.height, alignment: .leading)
                .clipped()
                .overlay {
                    // Shifted toward the paper, more so behind the name, so the map stays in the background.
                    LinearGradient(stops: [.init(color: Theme.paper.opacity(0.88), location: 0),
                                           .init(color: Theme.paper.opacity(0.88), location: 0.35),
                                           .init(color: Theme.paper.opacity(0.55), location: 0.75),
                                           .init(color: Theme.paper.opacity(0.7), location: 1)],
                                   startPoint: .leading, endPoint: .trailing)
                }
                .overlay {
                    marker.position(x: g.size.width * 0.75, y: g.size.height / 2)
                }
                // Fades into the page at the top and bottom.
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.15),
                                             .init(color: .black, location: 0.8), .init(color: .clear, location: 1)],
                                     startPoint: .top, endPoint: .bottom))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// A dot for a street address; a soft circle when only the area is known.
    @ViewBuilder private var marker: some View {
        if point.precision == "address" {
            Circle().fill(Theme.brand).frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(Theme.card, lineWidth: 2).padding(-2))
        } else {
            Circle().fill(Theme.brand.opacity(0.12)).frame(width: 56, height: 56)
                .overlay(Circle().strokeBorder(Theme.brand.opacity(0.45), lineWidth: 1))
        }
    }
}

private struct HeaderMapView: UIViewRepresentable {
    let point: MapPoint
    @Environment(\.colorScheme) private var scheme

    func makeUIView(context: Context) -> MLNMapView {
        let map = MLNMapView(frame: .zero, styleURL: scheme == .dark ? MapStyle.dark : MapStyle.light)
        map.isUserInteractionEnabled = false
        map.logoView.isHidden = true
        map.attributionButton.isHidden = true
        map.compassView.isHidden = true
        return map
    }

    func updateUIView(_ map: MLNMapView, context: Context) {
        let url = scheme == .dark ? MapStyle.dark : MapStyle.light
        if map.styleURL != url { map.styleURL = url }
        let zoom: Double = switch point.precision {
        case "address": 13.5
        case "neighborhood": 12.5
        case "postal": 11.5
        case "city": 10.5
        default: 6.5
        }
        map.setCenter(CLLocationCoordinate2D(latitude: point.lat, longitude: point.lng), zoomLevel: zoom, animated: false)
    }
}
