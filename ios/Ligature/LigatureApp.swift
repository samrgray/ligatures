import SwiftUI

@main
struct LigatureApp: App {
    @State private var store = Store()

    init() {
        // Contact photos come back often; keep them around between launches.
        URLCache.shared = URLCache(memoryCapacity: 32 << 20, diskCapacity: 256 << 20)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task { await store.boot() }
        }
    }
}

struct RootView: View {
    @Environment(Store.self) private var store
    /// Light, dark, or following the system.
    @AppStorage("appearance") private var appearance = Appearance.auto.rawValue
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var store = store
        Group {
            switch store.phase {
            case .loading:
                ProgressView()
            case .signedOut:
                SignInView()
            case .ready:
                ContactsListView()
            }
        }
        .preferredColorScheme(Appearance(rawValue: appearance)?.scheme)
        // Check Google when you come back after a minute away, and every five minutes while open.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.checkIfStale(60) } }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                if scenePhase == .active { await store.checkIfStale(295) }
            }
        }
        .alert(store.alertTitle, isPresented: $store.showAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.alertMessage)
        }
    }
}

/// The app’s light/dark setting.
enum Appearance: String, CaseIterable, Identifiable {
    case auto, light, dark
    var id: String { rawValue }
    var scheme: ColorScheme? { self == .light ? .light : self == .dark ? .dark : nil }
    var title: String { self == .auto ? "Automatic" : self == .light ? "Light" : "Dark" }
    var icon: String { self == .auto ? "circle.lefthalf.filled" : self == .light ? "sun.max" : "moon" }
    var next: Appearance { self == .auto ? .light : self == .light ? .dark : .auto }
}

/// One button for light, dark and automatic: tap to step through them, hold to pick one.
struct AppearanceButton: View {
    @AppStorage("appearance") private var appearance = Appearance.auto.rawValue

    var body: some View {
        let current = Appearance(rawValue: appearance) ?? .auto
        Menu {
            Picker("Appearance", selection: $appearance) {
                ForEach(Appearance.allCases) { a in Label(a.title, systemImage: a.icon).tag(a.rawValue) }
            }
        } label: {
            Image(systemName: current.icon)
        } primaryAction: {
            withAnimation { appearance = current.next.rawValue }
        }
        .accessibilityLabel("Appearance: \(current.title)")
    }
}
