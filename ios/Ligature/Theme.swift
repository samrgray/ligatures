import SwiftUI
import UIKit
import CoreText

/// Ligature’s look: warm paper with a little grain, soft cards on top, glass where things float.
/// The same palette as the web.
enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { t in UIColor(hex: t.userInterfaceStyle == .dark ? dark : light) })
    }

    /// The ground everything sits on.
    static let paper = dynamic(0xF1ECE5, 0x161412)
    /// Cards and table cells.
    static let card = dynamic(0xFFFDFA, 0x211F1C)
    /// Behind the sections of a contact card.
    static let cardGround = dynamic(0xF7F2EC, 0x1B1917)
    static let line = dynamic(0xE6DFD5, 0x38332D)
    /// Table rows you’ve ticked: the card shifted toward the warm accent.
    static let selected = dynamic(0xFBEDE2, 0x2E2620)
    /// The warm accent: the app mark, drafts, small highlights.
    static let brand = dynamic(0xE2722F, 0xF08A4B)
    static let ink = dynamic(0x2A2622, 0xF1ECE5)
    static let shadow = Color(red: 60 / 255, green: 40 / 255, blue: 20 / 255)

    /// A tile of fine noise, made once.
    static let grain: Image = {
        let size = 128
        var rng = SystemRandomNumberGenerator()
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        let image = renderer.image { ctx in
            for y in 0..<size {
                for x in 0..<size {
                    let v = CGFloat(UInt8.random(in: 0...255, using: &rng)) / 255
                    ctx.cgContext.setFillColor(UIColor(red: 0.3, green: 0.22, blue: 0.15, alpha: v * 0.05).cgColor)
                    ctx.cgContext.fill(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        }
        return Image(uiImage: image).resizable(resizingMode: .tile)
    }()
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// Paper, with grain and a soft warm light from the top corner and a cool one from below.
struct PaperBackground: View {
    var body: some View {
        ZStack {
            Theme.paper
            RadialGradient(colors: [Color(red: 1, green: 0.77, blue: 0.59).opacity(0.22), .clear], center: .topLeading, startRadius: 0, endRadius: 520)
            RadialGradient(colors: [Color(red: 0.63, green: 0.73, blue: 1).opacity(0.14), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 560)
            Theme.grain.blendMode(.multiply).accessibilityHidden(true)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

/// Grain over a surface (cards, glass), very lightly.
struct GrainOverlay: ViewModifier {
    func body(content: Content) -> some View {
        content.background { Theme.grain.opacity(0.5).blendMode(.multiply).accessibilityHidden(true) }
    }
}

extension View {
    func grain() -> some View { modifier(GrainOverlay()) }

    /// A soft, raised card.
    func softCard(radius: CGFloat = 16) -> some View {
        background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line.opacity(0.7), lineWidth: 0.5))
            .shadow(color: Theme.shadow.opacity(0.06), radius: 1, y: 1)
            .shadow(color: Theme.shadow.opacity(0.08), radius: 12, y: 6)
    }
}

/// The font for all text: one of the fonts bundled in Fonts/ (SIL Open Font License,
/// Fonts/OFL.txt), chosen in Settings and shared with the web. Sizes follow the system text
/// styles and Dynamic Type.
enum AppFont {
    /// The fonts you can choose; the same list as on the web.
    static let families = ["Commissioner", "DM Sans", "Funnel Sans", "Geist", "Golos Text", "Hanken Grotesk", "Inclusive Sans",
                           "Libre Franklin", "Miranda Sans", "Public Sans", "Schibsted Grotesk", "Strichpunkt Sans", "Zalando Sans"]

    /// The font in use. Set through the store, which saves it.
    static var family = families.contains(UserDefaults.standard.string(forKey: "font") ?? "")
        ? UserDefaults.standard.string(forKey: "font")! : "Commissioner"

    static func register() {
        for url in Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [] {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    /// A face’s PostScript name: “GolosText-SemiBold”.
    static func name(_ weight: Font.Weight, family: String = family) -> String {
        let face = switch weight {
        case .medium: "Medium"
        case .semibold: "SemiBold"
        case .bold, .heavy, .black: "Bold"
        default: "Regular"
        }
        return family.replacingOccurrences(of: " ", with: "") + "-" + face
    }

    /// The system’s size for each text style, at the default Dynamic Type setting.
    static func size(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 17
        }
    }

    /// For UIKit: navigation titles, bar buttons, segmented controls, map labels.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular, scaledFor style: UIFont.TextStyle? = nil) -> UIFont {
        let font = UIFont(name: name(weight), size: size) ?? .systemFont(ofSize: size)
        return style.map { UIFontMetrics(forTextStyle: $0).scaledFont(for: font) } ?? font
    }

    /// The bars and controls SwiftUI draws with UIKit.
    static func styleUIKit() {
        let nav = UINavigationBar.appearance()
        nav.titleTextAttributes = [.font: ui(17, .semibold, scaledFor: .headline)]
        nav.largeTitleTextAttributes = [.font: ui(34, .bold, scaledFor: .largeTitle)]
        for state in [UIControl.State.normal, .highlighted, .disabled] {
            UIBarButtonItem.appearance().setTitleTextAttributes([.font: ui(17, scaledFor: .body)], for: state)
        }
        UISegmentedControl.appearance().setTitleTextAttributes([.font: ui(13, .medium, scaledFor: .footnote)], for: .normal)
        UISegmentedControl.appearance().setTitleTextAttributes([.font: ui(13, .semibold, scaledFor: .footnote)], for: .selected)
        UITextField.appearance(whenContainedInInstancesOf: [UISearchBar.self]).font = ui(17, scaledFor: .body)
    }
}

extension Font {
    /// The chosen font at a text style’s size (scaling with Dynamic Type); headlines are semibold.
    static func app(_ style: Font.TextStyle, _ weight: Font.Weight? = nil) -> Font {
        .custom(AppFont.name(weight ?? (style == .headline ? .semibold : .regular)), size: AppFont.size(style), relativeTo: style)
    }

    /// The chosen font at a fixed size, for text that has to fit a shape (initials, badges, the index).
    static func app(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(AppFont.name(weight), fixedSize: size)
    }
}
