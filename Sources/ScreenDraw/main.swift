import Carbon.HIToolbox
import Cocoa
import ServiceManagement
import Sparkle
import WebKit

// A hidden helper (no Dock icon, no menu bar item). ⌥G shows a transparent
// full-screen drawing overlay on the screen under the mouse; double-tapping
// Escape (or ⌥G again) clears it and hands focus back to the previous app.

// A non-activating panel (like Spotlight/Raycast) takes keyboard focus without
// making the app you were in inactive, so closing it drops you right back.
final class OverlayPanel: NSPanel {
    var isEditingText = false

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // There is no active menu bar for a non-activating panel, so route the
    // standard editing shortcuts to the focused text box ourselves. Outside of
    // text editing the web page handles ⌘ shortcuts (undo, copy shapes, …).
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        // There's no menu bar, so ⌘Q (while drawing) is the way to quit.
        if flags == .command, event.charactersIgnoringModifiers?.lowercased() == "q" {
            NSApp.terminate(nil)
            return true
        }
        if isEditingText, flags == .command || flags == [.command, .shift],
           let key = event.charactersIgnoringModifiers?.lowercased() {
            let action: Selector? = switch (key, flags.contains(.shift)) {
            case ("x", false): #selector(NSText.cut(_:))
            case ("c", false): #selector(NSText.copy(_:))
            case ("v", false): #selector(NSText.paste(_:))
            case ("a", false): #selector(NSResponder.selectAll(_:))
            case ("z", false): Selector(("undo:"))
            case ("z", true): Selector(("redo:"))
            default: nil
            }
            if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler,
    SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    private var window: OverlayPanel!
    private var webView: WKWebView!
    private var hotKeyRef: EventHotKeyRef?
    private var isShown = false
    private var updaterController: SPUStandardUpdaterController?
    private var installUpdate: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Only one copy runs (e.g. a login item plus a manual launch).
        let me = NSRunningApplication.current
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id)
               .contains(where: { $0 != me && !$0.isTerminated }) {
            NSApp.terminate(nil)
            return
        }
        createWindow()
        registerHotKey()
        NotificationCenter.default.addObserver(
            self, selector: #selector(windowDidResignKey),
            name: NSWindow.didResignKeyNotification, object: window)
        firstLaunchSetup()
        startUpdater()
    }

    // MARK: Updates

    // There's no UI to offer updates in, so Sparkle checks and downloads them in
    // the background (SUAutomaticallyUpdate in Info.plist) and the app installs
    // a downloaded update the next time the overlay is hidden. Installing quits
    // and relaunches the app, which takes about a second and shows nothing.
    // Dev builds leave SUFeedURL out of Info.plist and don't update.
    private func startUpdater() {
        guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil else { return }
        updaterController = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock: @escaping () -> Void) -> Bool {
        NSLog("ScreenDraw: downloaded update \(item.displayVersionString)")
        installUpdate = immediateInstallationBlock
        installUpdateIfIdle()
        return true
    }

    private func installUpdateIfIdle() {
        guard !isShown, let install = installUpdate else { return }
        installUpdate = nil
        NSLog("ScreenDraw: installing update and relaunching")
        install()
    }

    // Sparkle asks background apps to opt in to quiet reminders for updates it
    // can't install silently (for example when installing needs a password).
    var supportsGentleScheduledUpdateReminders: Bool { true }

    // MARK: First launch

    // The first time it runs from a real install (not the disk image), the app
    // adds itself to Login Items. That's removable in System Settings.
    private func firstLaunchSetup() {
        let defaults = UserDefaults.standard
        let path = Bundle.main.bundlePath
        guard !defaults.bool(forKey: "didFirstLaunch"),
              !path.hasPrefix("/Volumes/"), !path.contains("/AppTranslocation/") else { return }
        defaults.set(true, forKey: "didFirstLaunch")
        do {
            try SMAppService.mainApp.register()
        } catch {
            NSLog("ScreenDraw: could not add login item: \(error)")
        }
    }

    // MARK: Window

    private func createWindow() {
        let frame = NSScreen.main?.frame ?? .zero
        window = OverlayPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isFloatingPanel = true
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.isReleasedWhenClosed = false
        // Explicitly opt in so clicks on fully transparent pixels still land on us.
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "bridge")
        // Hand the saved artboard history to the page before its script runs.
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__SD_HISTORY = \(loadHistoryJSON());",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView

        if let url = Bundle.main.url(forResource: "overlay", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            NSLog("ScreenDraw: overlay.html missing from bundle")
        }
    }

    // MARK: Artboard history (last 100 boards, kept across restarts)

    private let historyQueue = DispatchQueue(label: "dev.moulik.screendraw.history")

    private var historyURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("ScreenDraw/history.json")
    }

    private func loadHistoryJSON() -> String {
        guard let data = try? Data(contentsOf: historyURL),
              (try? JSONSerialization.jsonObject(with: data)) is [Any],
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    private func saveHistory(_ json: String) {
        let url = historyURL
        historyQueue.async {
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(json.utf8).write(to: url, options: .atomic)
            } catch {
                NSLog("ScreenDraw: could not save history: \(error)")
            }
        }
    }

    private func screenUnderMouse() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    // MARK: Show / hide

    @objc func toggle() {
        isShown ? hide() : show()
    }

    private func show() {
        guard !isShown else { return }
        isShown = true
        window.ignoresMouseEvents = false
        if let screen = screenUnderMouse() { window.setFrame(screen.frame, display: false) }
        webView.evaluateJavaScript("window.SD && SD.show()") { [weak self] _, _ in
            guard let self, self.isShown else { return }
            self.window.makeKeyAndOrderFront(nil)
            self.window.makeFirstResponder(self.webView)
            NSLog("ScreenDraw: shown (key window: \(self.window.isKeyWindow))")
        }
    }

    // Save + clear the board while the window is still on screen, and only
    // take the window down once the empty frame has been drawn. Otherwise the
    // old drawing would flash the next time the overlay opens.
    private func hide() {
        guard isShown else { return }
        isShown = false
        window.isEditingText = false
        window.ignoresMouseEvents = true
        let finish = { [weak self] in
            guard let self, !self.isShown, self.window.isVisible else { return }
            self.window.orderOut(nil)
            NSLog("ScreenDraw: hidden")
            self.installUpdateIfIdle()
        }
        webView.callAsyncJavaScript("if (window.SD) await SD.close(); return true;",
                                    arguments: [:], in: nil, in: .page) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: finish)
    }

    // Cmd-Tab, a click in another app's window that peeks through, etc. — if
    // the overlay loses keyboard focus, dismiss it so it never sits on top of
    // the screen eating clicks.
    @objc private func windowDidResignKey() {
        if isShown { hide() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "exit": hide()
        case "editing": window.isEditingText = body["value"] as? Bool ?? false
        case "history": if let json = body["json"] as? String { saveHistory(json) }
        default: break
        }
    }

    // MARK: Hotkey (⌥G)

    private func registerHotKey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { delegate.toggle() }
            return noErr
        }, 1, &eventType, selfPtr, nil)

        let hotKeyID = EventHotKeyID(signature: OSType(0x5344_5257), id: 1) // "SDRW"
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_G), UInt32(optionKey), hotKeyID,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr { NSLog("ScreenDraw: could not register ⌥G (status \(status))") }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
