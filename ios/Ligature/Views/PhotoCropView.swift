import SwiftUI

/// A photo to crop: the original (upright, from `Photo.original`) and where the crop was last.
struct CropJob: Identifiable {
    let id = UUID()
    let image: UIImage
    var crop: PhotoCrop?
}

/// Position and zoom a photo in a circle: drag to move it, pinch to zoom. The circle is what’s
/// kept; the rest of the photo shows dimmed around it.
struct PhotoCropView: View {
    let job: CropJob
    let onDone: (PhotoCrop) -> Void

    @Environment(\.dismiss) private var dismiss

    /// k is points per image pixel; (tx, ty) is the image’s top-left corner relative to the
    /// circle’s, so both are ≤ 0 while the photo covers the circle.
    private struct Placement {
        var k: CGFloat = 0
        var tx: CGFloat = 0
        var ty: CGFloat = 0
    }

    @State private var placed = Placement()
    @State private var side: CGFloat = 0
    @State private var drag: CGSize = .zero
    @State private var pinch: (scale: CGFloat, anchor: CGPoint)?

    private static let inset: CGFloat = 20
    private static let maxZoom: CGFloat = 6

    private var size: CGSize { job.image.size }
    private var kMin: CGFloat { side / max(1, min(size.width, size.height)) }

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let d = min(geo.size.width, geo.size.height) - 2 * Self.inset
                let origin = CGPoint(x: (geo.size.width - d) / 2, y: (geo.size.height - d) / 2)
                let p = live
                ZStack {
                    Color.black
                    photo(p, at: origin).brightness(-0.6).saturation(0.7)
                    photo(p, at: origin)
                        .mask { Circle().frame(width: d, height: d).position(x: origin.x + d / 2, y: origin.y + d / 2) }
                    Circle().stroke(Color(white: 0.85), lineWidth: 1)
                        .frame(width: d, height: d)
                        .position(x: origin.x + d / 2, y: origin.y + d / 2)
                        .allowsHitTesting(false)
                }
                .clipped()
                .contentShape(Rectangle())
                .gesture(
                    SimultaneousGesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { drag = $0.translation }
                            .onEnded { _ in endDrag() },
                        MagnifyGesture()
                            .onChanged { v in
                                pinch = (v.magnification, CGPoint(x: v.startLocation.x - origin.x, y: v.startLocation.y - origin.y))
                            }
                            .onEnded { _ in endPinch() }
                    )
                )
                .onAppear { layout(d) }
                .onChange(of: d) { _, new in layout(new) }
            }
            .background(Color.black)
            .navigationTitle("Crop Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.black, for: .navigationBar, .bottomBar)
            .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .bottomBar) {
                    HStack {
                        Text("Drag to move, pinch to zoom").font(.app(.footnote)).foregroundStyle(.secondary)
                        Spacer()
                        Button("Reset") { place(Photo.centredCrop(size)) }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onDone(crop(of: clamped(live)))
                        dismiss()
                    }
                    .bold()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    /// The photo, filling the screen, placed relative to the circle at `origin`.
    private func photo(_ p: Placement, at origin: CGPoint) -> some View {
        Color.clear.overlay(alignment: .topLeading) {
            Image(uiImage: job.image)
                .resizable()
                .frame(width: size.width * p.k, height: size.height * p.k)
                .offset(x: origin.x + p.tx, y: origin.y + p.ty)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: Placement

    /// Where the photo is right now: what’s settled, plus any pinch and drag under way.
    private var live: Placement {
        var p = placed
        if let pinch { p = zoomed(p, by: pinch.scale, around: pinch.anchor) }
        p.tx += drag.width
        p.ty += drag.height
        return clamped(p)
    }

    private func zoomed(_ p: Placement, by f: CGFloat, around a: CGPoint) -> Placement {
        let k = min(kMin * Self.maxZoom, max(kMin, p.k * f))
        let r = p.k > 0 ? k / p.k : 1
        return Placement(k: k, tx: a.x - (a.x - p.tx) * r, ty: a.y - (a.y - p.ty) * r)
    }

    private func clamped(_ p: Placement) -> Placement {
        var p = p
        p.k = min(kMin * Self.maxZoom, max(kMin, p.k))
        p.tx = min(0, max(side - size.width * p.k, p.tx))
        p.ty = min(0, max(side - size.height * p.k, p.ty))
        return p
    }

    private func endDrag() {
        if let pinch {
            // The pinch carries on: keep the move, in terms of the photo before the pinch.
            let r = zoomed(placed, by: pinch.scale, around: pinch.anchor).k / max(placed.k, 0.0001)
            placed.tx += drag.width / r
            placed.ty += drag.height / r
        } else {
            placed = live
        }
        drag = .zero
    }

    private func endPinch() {
        guard let pinch else { return }
        placed = zoomed(placed, by: pinch.scale, around: pinch.anchor)
        self.pinch = nil
        if drag == .zero { placed = clamped(placed) }
    }

    private func layout(_ d: CGFloat) {
        guard d > 0, d != side else { return }
        let was = side > 0 ? crop(of: clamped(placed)) : (job.crop ?? Photo.centredCrop(size))
        side = d
        place(was)
    }

    private func place(_ c: PhotoCrop) {
        let k = side / max(1, c.w * size.width)
        placed = clamped(Placement(k: k, tx: -c.x * size.width * k, ty: -c.y * size.height * k))
    }

    private func crop(of p: Placement) -> PhotoCrop {
        PhotoCrop(
            x: -p.tx / (size.width * p.k), y: -p.ty / (size.height * p.k),
            w: side / (size.width * p.k), h: side / (size.height * p.k)
        )
    }
}
