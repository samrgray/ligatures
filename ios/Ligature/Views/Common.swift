import SwiftUI
import UIKit

/// A contact photo, or initials on grey when there’s none.
struct Avatar: View {
    let url: String
    let initials: String
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().fill(LinearGradient(colors: [Color(red: 0.75, green: 0.69, blue: 0.62), Color(red: 0.59, green: 0.53, blue: 0.47)], startPoint: .top, endPoint: .bottom))
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            if let image = shown {
                Image(uiImage: image).resizable().scaledToFill()
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: "\(px) \(url)") {
            if let have = Photo.cache.object(forKey: url as NSString), have.px >= px {
                loaded = (url, have.image)
                return
            }
            if let image = await Photo.load(url, px: px), !Task.isCancelled { loaded = (url, image) }
        }
    }

    @State private var loaded: (url: String, image: UIImage)?

    /// Sizes go up in steps, so pinching only fetches a few times.
    private var px: Int { max(1, Int((size * 3 / 64).rounded(.up))) * 64 }

    /// Whatever’s on hand for this photo, at any size, so it never blanks while a sharper one loads.
    private var shown: UIImage? {
        if let loaded, loaded.url == url { return loaded.image }
        return Photo.cache.object(forKey: url as NSString)?.image
    }
}

enum Photo {
    final class Cached {
        let px: Int
        let image: UIImage
        init(px: Int, image: UIImage) { self.px = px; self.image = image }
    }

    /// The sharpest copy loaded so far of each photo, by its stored URL.
    static let cache = NSCache<NSString, Cached>()

    static func load(_ raw: String, px: Int) async -> UIImage? {
        guard let u = url(raw, px: px),
              let (data, _) = try? await URLSession.shared.data(from: u),
              let image = UIImage(data: data) else { return nil }
        // Only Google photos come in sizes; anything else is already full size.
        let got = raw.contains("googleusercontent.com") ? px : .max
        if (cache.object(forKey: raw as NSString)?.px ?? 0) < got {
            cache.setObject(Cached(px: got, image: image), forKey: raw as NSString)
        }
        return image
    }

    /// Google photo URLs take a size suffix; ask for one that fits.
    static func url(_ raw: String, px: Int) -> URL? {
        guard !raw.isEmpty else { return nil }
        if raw.contains("googleusercontent.com") {
            let base = raw.replacingOccurrences(of: #"=s\d+(-c)?$"#, with: "", options: .regularExpression)
            return URL(string: "\(base)=s\(px)-c")
        }
        return URL(string: raw)
    }

    /// Crop to a centred square and save as JPEG, the way the web app does.
    static func squareJPEG(_ image: UIImage, side: CGFloat = 512) -> Data? {
        let s = min(image.size.width, image.size.height)
        guard s > 0 else { return nil }
        let k = side / s
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        let out = renderer.image { _ in
            image.draw(in: CGRect(
                x: -(image.size.width - s) / 2 * k, y: -(image.size.height - s) / 2 * k,
                width: image.size.width * k, height: image.size.height * k
            ))
        }
        return out.jpegData(compressionQuality: 0.85)
    }
}

enum Links {
    static func digits(_ phone: String) -> String {
        phone.filter { $0.isNumber || $0 == "+" }
    }

    static func tel(_ phone: String) -> URL? { URL(string: "tel:\(digits(phone))") }
    static func sms(_ phone: String) -> URL? { URL(string: "sms:\(digits(phone))") }
    static func mail(_ email: String) -> URL? {
        URL(string: "mailto:\(email.trimmingCharacters(in: .whitespaces))")
    }

    static func maps(_ address: String) -> URL? {
        var c = URLComponents(string: "https://maps.apple.com/")
        c?.queryItems = [URLQueryItem(name: "q", value: address.replacingOccurrences(of: "\n", with: ", "))]
        return c?.url
    }

    static func web(_ raw: String) -> URL? {
        URL(string: raw.lowercased().hasPrefix("http") ? raw : "https://\(raw)")
    }
}

enum PhoneFormat {
    /// 5035550142 → (503) 555-0142 as you type. Numbers with +, dots, letters, a leading 0 or 1,
    /// or more than 10 digits are left as typed.
    static func typing(_ value: String) -> String {
        guard value.allSatisfy({ $0.isNumber || " ()-".contains($0) }) else { return value }
        let d = value.filter(\.isNumber)
        guard let first = d.first, first != "0", first != "1", d.count <= 10 else { return value }
        let a = Array(d)
        if a.count <= 3 { return d }
        if a.count <= 6 { return "(\(String(a[0..<3]))) \(String(a[3...]))" }
        return "(\(String(a[0..<3]))) \(String(a[3..<6]))-\(String(a[6...]))"
    }
}

func copyToClipboard(_ s: String) {
    UIPasteboard.general.string = s
}

/// Shows the store’s alert. Each sheet adds it too, since an alert can’t appear over a sheet
/// from the view underneath.
struct StoreAlert: ViewModifier {
    @Environment(Store.self) private var store

    func body(content: Content) -> some View {
        @Bindable var store = store
        content.alert(store.alertTitle, isPresented: $store.showAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.alertMessage)
        }
    }
}

extension View {
    func storeAlert() -> some View { modifier(StoreAlert()) }
}

/// Press and hold a contact’s photo to start selecting. UIKit’s long-press recognizer, so the
/// list still scrolls, and the row’s context menu waits for it rather than opening as well.
struct HoldToSelect: UIGestureRecognizerRepresentable {
    let enabled: Bool
    let action: () -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            !(other is UIPanGestureRecognizer)
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let g = UILongPressGestureRecognizer()
        g.minimumPressDuration = 0.35
        g.allowableMovement = 10
        g.delegate = context.coordinator
        g.isEnabled = enabled
        return g
    }

    func updateUIGestureRecognizer(_ g: UILongPressGestureRecognizer, context: Context) {
        g.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ g: UILongPressGestureRecognizer, context: Context) {
        guard g.state == .began else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        action()
    }
}
