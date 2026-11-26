import Carbon.HIToolbox
import Cocoa
import ScreenCaptureKit
import ServiceManagement
import Sparkle
import WebKit

// A hidden helper (no Dock icon, no menu bar item).
//
// ⌥G shows a transparent full-screen drawing overlay on the screen under the
// mouse; double-tapping Escape (or ⌥G again) clears it and hands focus back to
// the previous app.
//
// ⌥⇧S takes a screenshot and holds it over the screen with a note bar at the
// bottom (@folder, #tag). Enter saves it to the library (Library.swift), Escape
// drops it, ⌥G draws on it. While drawing, ⌥⇧S saves the drawing over its
// screen the same way and goes back to drawing.
//
// ⌥⇧D opens the library's search in Raycast (the extension in raycast/).

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
    // The screen as it was when ⌥G opened the overlay, shown behind the drawing
    // until Tab switches to the live screen. A board saved to history keeps its
    // still in a file named after `sessionShot`, so recalling the board brings
    // the screen it was drawn on back with it.
    private var frozenView: NSView!
    private var snapshot: CGImage?
    private var sessionShot = ""
    private var sessionShotWanted = false
    private var sessionShotSaved = false
    // The still behind the board on screen: this session's, or a recalled
    // board's own (`boardShot`), with its pixels per point.
    private var shown: CGImage?
    private var shownScale: CGFloat = 1
    private var boardShot: String?
    private var showsSnapshot = true
    private var isCapturing = false
    private var showCount = 0
    private var hotKeyRefs: [EventHotKeyRef] = []
    private var isShown = false
    // ⌥⇧S: the window is up only to hold a screenshot (no drawing), and
    // whether the note bar is open (in either mode). `pending` is the image the
    // note goes with; a note that's sent before it's ready waits in `queuedNote`.
    private var captureOnly = false
    private var noteOpen = false
    private var noteID = 0
    private var pending: (image: CGImage, kind: String)?
    private var queuedNote: [String: Any]?
    private var captureScale: CGFloat = 1
    private var updaterController: SPUStandardUpdaterController?
    private var installUpdate: (() -> Void)?

    // screenutils://draw, screenutils://capture and screenutils://search do
    // what the shortcuts do. Registered before launch finishes so a URL that
    // launches the app isn't missed.
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self, andSelector: #selector(handleURL(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let string = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: string) else { return }
        // Before the window exists (the URL launched the app), wait for it.
        guard window != nil else {
            DispatchQueue.main.async { [weak self] in self?.handleURL(event, reply: reply) }
            return
        }
        switch url.host {
        case "draw": toggle()
        case "capture": capture()
        case "search": openSearch()
        default: NSLog("ScreenUtils: unknown URL \(string)")
        }
    }

    // Opening the app again (Spotlight, Raycast, Finder) toggles drawing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        toggle()
        return false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Only one copy runs (e.g. a login item plus a manual launch).
        let me = NSRunningApplication.current
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id)
               .contains(where: { $0 != me && !$0.isTerminated }) {
            NSApp.terminate(nil)
            return
        }
        if moveToNewName() { return }
        migrateSupportFolder()
        let info = Bundle.main.infoDictionary ?? [:]
        NSLog("ScreenUtils: started version \(info["CFBundleShortVersionString"] ?? "?") (build \(info["CFBundleVersion"] ?? "?"))")
        createWindow()
        registerHotKeys()
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
        NSLog("ScreenUtils: downloaded update \(item.displayVersionString)")
        installUpdate = immediateInstallationBlock
        installUpdateIfIdle()
        return true
    }

    private func installUpdateIfIdle() {
        guard !isShown, let install = installUpdate else { return }
        installUpdate = nil
        // Let a board or still that is being written finish first.
        historyQueue.async { [weak self] in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard !self.isShown else {
                    self.installUpdate = install
                    return
                }
                NSLog("ScreenUtils: installing update and relaunching")
                install()
            }
        }
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
        // Moved from ScreenDraw.app while it was a login item (moveToNewName).
        if defaults.bool(forKey: "reregisterLoginItem") {
            defaults.removeObject(forKey: "reregisterLoginItem")
            do { try SMAppService.mainApp.register() } catch { NSLog("ScreenUtils: could not add login item: \(error)") }
        }
        guard !defaults.bool(forKey: "didFirstLaunch"),
              !path.hasPrefix("/Volumes/"), !path.contains("/AppTranslocation/") else { return }
        defaults.set(true, forKey: "didFirstLaunch")
        do {
            try SMAppService.mainApp.register()
        } catch {
            NSLog("ScreenUtils: could not add login item: \(error)")
        }
    }

    // MARK: Rename from ScreenDraw

    // Sparkle installs updates where the app already is, so a copy installed
    // as ScreenDraw.app stays that way. The first launch of this version
    // renames it to ScreenUtils.app and relaunches from there. The bundle ID
    // is the same, so Screen Recording access and settings carry over.
    // Returns true when the app is relaunching.
    private func moveToNewName() -> Bool {
        let old = Bundle.main.bundleURL
        let path = old.path
        guard old.lastPathComponent == "ScreenDraw.app",
              !path.hasPrefix("/Volumes/"), !path.contains("/AppTranslocation/") else { return false }
        let new = old.deletingLastPathComponent().appendingPathComponent("ScreenUtils.app")
        guard !FileManager.default.fileExists(atPath: new.path) else { return false }
        let wasLoginItem = SMAppService.mainApp.status == .enabled
        if wasLoginItem { try? SMAppService.mainApp.unregister() }
        do {
            try FileManager.default.moveItem(at: old, to: new)
        } catch {
            NSLog("ScreenUtils: could not rename \(path): \(error)")
            if wasLoginItem { try? SMAppService.mainApp.register() }
            return false
        }
        NSLog("ScreenUtils: renamed \(path) to \(new.path), relaunching")
        if wasLoginItem { UserDefaults.standard.set(true, forKey: "reregisterLoginItem") }
        // Start the renamed copy once this one has quit, so it isn't turned
        // away as a second copy.
        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
        relaunch.arguments = ["-c", "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.1; done; open \"$0\"", new.path]
        try? relaunch.run()
        NSApp.terminate(nil)
        return true
    }

    // Boards and stills moved from Application Support/ScreenDraw.
    private func migrateSupportFolder() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let old = support.appendingPathComponent("ScreenDraw")
        let new = support.appendingPathComponent("ScreenUtils")
        guard FileManager.default.fileExists(atPath: old.path),
              !FileManager.default.fileExists(atPath: new.path) else { return }
        do { try FileManager.default.moveItem(at: old, to: new) } catch {
            NSLog("ScreenUtils: could not move \(old.path): \(error)")
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

        let container = NSView(frame: NSRect(origin: .zero, size: frame.size))
        frozenView = NSView(frame: container.bounds)
        frozenView.wantsLayer = true
        frozenView.layer?.contentsGravity = .resize
        frozenView.isHidden = true
        container.addSubview(frozenView)
        container.addSubview(webView)
        window.contentView = container

        if let url = Bundle.main.url(forResource: "overlay", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            NSLog("ScreenUtils: overlay.html missing from bundle")
        }
    }

    // MARK: Artboard history (last 100 boards, kept across restarts)

    private let historyQueue = DispatchQueue(label: "dev.moulik.screenutils.history")

    private var historyURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("ScreenUtils/history.json")
    }

    private func loadHistoryJSON() -> String {
        guard let data = try? Data(contentsOf: historyURL),
              (try? JSONSerialization.jsonObject(with: data)) is [Any],
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    private var shotsURL: URL { historyURL.deletingLastPathComponent().appendingPathComponent("stills") }

    // A still's name is a UUID plus the pixels per point it was taken at,
    // like "…@2x". Names come from the page, so anything else is refused.
    private func shotURL(_ id: String) -> URL? {
        guard id.range(of: "^[0-9A-F-]{36}@[1-9]x$", options: .regularExpression) != nil else { return nil }
        return shotsURL.appendingPathComponent(id + ".heic")
    }

    // `shots` are the stills the saved boards use. Others are deleted.
    private func saveHistory(_ json: String, shots: [String]) {
        let url = historyURL
        let dir = shotsURL
        let keep = Set(shots + [sessionShot])
        historyQueue.async {
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(json.utf8).write(to: url, options: .atomic)
            } catch {
                NSLog("ScreenUtils: could not save history: \(error)")
                return
            }
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for file in files where !keep.contains(file.deletingPathExtension().lastPathComponent) {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func screenUnderMouse() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    // MARK: Show / hide

    @objc func toggle() {
        if captureOnly { return drawOnCapture() }
        isShown ? hide() : show()
    }

    private func show() {
        guard !isShown else { return }
        isShown = true
        window.ignoresMouseEvents = false
        clearSnapshot()
        let screen = screenUnderMouse()
        if let screen {
            window.setFrame(screen.frame, display: false)
            sessionShot = "\(UUID().uuidString)@\(max(1, Int(screen.backingScaleFactor)))x"
            if CGPreflightScreenCaptureAccess() {
                captureSnapshot(of: screen)
            } else if #available(macOS 14.0, *), !UserDefaults.standard.bool(forKey: "askedScreenAccess") {
                // Without access the overlay draws over the live screen.
                requestScreenAccess()
            }
        }
        webView.evaluateJavaScript("window.SD && SD.show('\(sessionShot)')") { [weak self] _, _ in
            guard let self, self.isShown else { return }
            self.window.makeKeyAndOrderFront(nil)
            self.window.makeFirstResponder(self.webView)
            NSLog("ScreenUtils: shown (key window: \(self.window.isKeyWindow))")
        }
    }

    // Save + clear the board while the window is still on screen, and only
    // take the window down once the empty frame has been drawn. Otherwise the
    // old drawing would flash the next time the overlay opens.
    private func hide() {
        guard isShown else { return }
        isShown = false
        captureOnly = false
        endNote()
        window.isEditingText = false
        window.ignoresMouseEvents = true
        let finish = { [weak self] in
            guard let self, !self.isShown, self.window.isVisible else { return }
            self.window.orderOut(nil)
            self.clearSnapshot()
            NSLog("ScreenUtils: hidden")
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
        case "history":
            guard let json = body["json"] as? String else { break }
            let shots = body["shots"] as? [String] ?? []
            if shots.contains(sessionShot) {
                sessionShotWanted = true
                saveSessionShot()
            }
            saveHistory(json, shots: shots)
        case "background": toggleSnapshot()
        case "board": showBoardShot(body["shot"] as? String)
        case "note": noteFinished(body)
        default: break
        }
    }

    // MARK: Frozen background (Tab)

    private func clearSnapshot() {
        showCount += 1
        snapshot = nil
        sessionShot = ""
        sessionShotWanted = false
        sessionShotSaved = false
        shown = nil
        boardShot = nil
        showsSnapshot = true
        isCapturing = false
        updateFrozenView()
    }

    // The still keeps the size it was taken at, from the top left like the
    // drawing, so the two line up even on a screen of another size.
    private func updateFrozenView() {
        let image = showsSnapshot ? shown : nil
        frozenView.layer?.contents = image
        frozenView.isHidden = image == nil
        guard let image, let bounds = frozenView.superview?.bounds else { return }
        let size = NSSize(width: CGFloat(image.width) / shownScale, height: CGFloat(image.height) / shownScale)
        frozenView.frame = NSRect(x: 0, y: bounds.height - size.height, width: size.width, height: size.height)
    }

    private func showSessionShot() {
        shown = snapshot
        shownScale = CGFloat(Int(sessionShot.suffix(2).prefix(1)) ?? 1)
        updateFrozenView()
    }

    // A recalled board shows the still it was drawn on. A board without one
    // (or a new board) shows this session's.
    private func showBoardShot(_ id: String?) {
        boardShot = id == sessionShot ? nil : id
        guard let id = boardShot, let url = shotURL(id) else {
            boardShot = nil
            showSessionShot()
            return
        }
        let count = showCount
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let options = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
            let image = CGImageSourceCreateWithURL(url as CFURL, nil)
                .flatMap { CGImageSourceCreateImageAtIndex($0, 0, options) }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.showCount == count, self.boardShot == id else { return }
                guard let image else {
                    self.boardShot = nil
                    self.showSessionShot()
                    return
                }
                self.shown = image
                self.shownScale = CGFloat(Int(id.suffix(2).prefix(1)) ?? 1)
                self.updateFrozenView()
            }
        }
    }

    // Written once a saved board uses it, whether or not it was showing.
    private func saveSessionShot() {
        guard sessionShotWanted, !sessionShotSaved, let image = snapshot, let url = shotURL(sessionShot) else { return }
        sessionShotSaved = true
        historyQueue.async {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let quality = [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
            guard let file = CGImageDestinationCreateWithURL(url as CFURL, "public.heic" as CFString, 1, nil) else {
                NSLog("ScreenUtils: could not save the still")
                return
            }
            CGImageDestinationAddImage(file, image, quality)
            if !CGImageDestinationFinalize(file) { NSLog("ScreenUtils: could not save the still") }
        }
    }

    private func toggleSnapshot() {
        guard #available(macOS 14.0, *) else { return }
        guard CGPreflightScreenCaptureAccess() else {
            requestScreenAccess()
            return
        }
        // Access was granted after this overlay opened: take the shot now.
        if snapshot == nil, shown == nil, let screen = window.screen {
            showsSnapshot = true
            captureSnapshot(of: screen)
            return
        }
        showsSnapshot.toggle()
        updateFrozenView()
    }

    // The first time, macOS shows its own prompt. After that it stays silent,
    // so open the Screen Recording settings instead.
    private func requestScreenAccess() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: "askedScreenAccess") {
            hide()
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(url)
            }
        } else {
            defaults.set(true, forKey: "askedScreenAccess")
            CGRequestScreenCaptureAccess()
        }
    }

    private func captureSnapshot(of screen: NSScreen) {
        guard #available(macOS 14.0, *), !isCapturing else { return }
        isCapturing = true
        let count = showCount
        captureScreen(screen) { [weak self] image in
            guard let self, self.showCount == count else { return }
            self.isCapturing = false
            self.snapshot = image
            self.saveSessionShot()
            if self.boardShot == nil { self.showSessionShot() }
        }
    }

    // A picture of the screen at its full resolution, without this app's
    // windows. Calls back on the main queue, with nil if it failed.
    private func captureScreen(_ screen: NSScreen, _ done: @escaping (CGImage?) -> Void) {
        guard #available(macOS 14.0, *),
              let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        else { return done(nil) }
        let width = Int(screen.frame.width * screen.backingScaleFactor)
        let height = Int(screen.frame.height * screen.backingScaleFactor)
        let finish: (CGImage?, Error?) -> Void = { image, error in
            if let error { NSLog("ScreenUtils: screen capture failed: \(error)") }
            DispatchQueue.main.async { done(image) }
        }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard let content, let display = content.displays.first(where: { $0.displayID == displayID }) else {
                finish(nil, error)
                return
            }
            // Leave our own overlay out of the picture.
            let me = content.applications.filter { $0.processID == getpid() }
            let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config, completionHandler: finish)
        }
    }

    // MARK: Screenshots (⌥⇧S)

    private var takingScreenshot = false

    @objc func capture() {
        guard !noteOpen, !takingScreenshot else { return }
        if isShown { return captureDrawing() }
        guard #available(macOS 14.0, *) else {
            NSLog("ScreenUtils: screenshots need macOS 14")
            return
        }
        guard CGPreflightScreenCaptureAccess() else { return requestScreenAccess() }
        guard let screen = screenUnderMouse() else { return }
        takingScreenshot = true
        captureScreen(screen) { [weak self] image in
            guard let self else { return }
            self.takingScreenshot = false
            // ⌥G may have opened the drawing layer in the meantime.
            guard let image, !self.isShown else { return }
            self.showCapture(image, on: screen)
        }
    }

    // Hold the screenshot over the screen with the note bar open.
    private func showCapture(_ image: CGImage, on screen: NSScreen) {
        isShown = true
        captureOnly = true
        window.ignoresMouseEvents = false
        clearSnapshot()
        window.setFrame(screen.frame, display: false)
        captureScale = screen.backingScaleFactor
        snapshot = image
        shown = image
        shownScale = captureScale
        updateFrozenView()
        openNote(kind: "screenshot") { [weak self] _ in
            guard let self, self.captureOnly else { return }
            self.pending = (image, "screenshot")
            self.window.makeKeyAndOrderFront(nil)
            self.window.makeFirstResponder(self.webView)
        }
    }

    // ⌥G on a held screenshot: draw on it, like ⌥G on the screen.
    private func drawOnCapture() {
        guard captureOnly else { return }
        captureOnly = false
        endNote()
        sessionShot = "\(UUID().uuidString)@\(max(1, Int(captureScale)))x"
        webView.evaluateJavaScript("window.SD && SD.show('\(sessionShot)')")
    }

    // ⌥⇧S while drawing: the drawing over the still it's on (or over the live
    // screen, taken now), saved with a note. Drawing carries on afterwards.
    private func captureDrawing() {
        let id = beginNote()
        let still = showsSnapshot ? shown.map { (image: $0, scale: shownScale) } : nil
        let screen = window.screen ?? screenUnderMouse()
        let points = window.frame.size
        openNote(kind: "drawing") { [weak self] result in
            guard let self, self.noteID == id else { return }
            guard let dataURL = result as? String, let drawing = Self.image(fromDataURL: dataURL) else {
                NSLog("ScreenUtils: could not export the drawing")
                return self.endNote()
            }
            let finish: ((image: CGImage, scale: CGFloat)?) -> Void = { [weak self] background in
                guard let self, self.noteID == id else { return }
                self.pending = (Self.composite(drawing, over: background, points: points), "drawing")
                if let queued = self.queuedNote { self.saveNote(queued) }
            }
            if let still { return finish(still) }
            guard let screen, CGPreflightScreenCaptureAccess() else { return finish(nil) }
            let scale = screen.backingScaleFactor
            self.captureScreen(screen) { finish($0.map { (image: $0, scale: scale) }) }
        }
    }

    @discardableResult
    private func beginNote() -> Int {
        noteID += 1
        noteOpen = true
        pending = nil
        queuedNote = nil
        return noteID
    }

    private func endNote() {
        noteID += 1
        noteOpen = false
        pending = nil
        queuedNote = nil
    }

    // The page opens the note bar and, for a drawing, returns it as a PNG.
    private func openNote(kind: String, then: @escaping (Any?) -> Void) {
        if kind == "screenshot" { beginNote() }
        let id = noteID
        webView.callAsyncJavaScript(
            "return window.SD ? SD.openNote(kind, suggestions) : null;",
            arguments: ["kind": kind, "suggestions": Library.shared.suggestions()],
            in: nil, in: .page) { [weak self] result in
            guard let self, self.noteID == id else { return }
            if case .failure(let error) = result { NSLog("ScreenUtils: could not open the note: \(error)") }
            then(try? result.get())
        }
    }

    // From the page: {action: "save", note, folder, tags} or {action: "cancel"}.
    private func noteFinished(_ body: [String: Any]) {
        guard noteOpen else { return }
        guard body["action"] as? String == "save" else {
            endNote()
            if captureOnly { hide() }
            return
        }
        // The drawing is still being put together; it saves when it's ready.
        guard pending != nil else {
            queuedNote = body
            return
        }
        saveNote(body)
    }

    private func saveNote(_ body: [String: Any]) {
        guard let pending else { return }
        Library.shared.save(
            pending.image, kind: pending.kind,
            note: body["note"] as? String ?? "",
            folder: body["folder"] as? String,
            tags: body["tags"] as? [String] ?? [])
        endNote()
        if captureOnly { hide() }
    }

    private static func image(fromDataURL url: String) -> CGImage? {
        guard let comma = url.firstIndex(of: ","),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    // The drawing (at the screen's pixel size) over the still, which keeps the
    // size it was taken at and sits at the top left, as it does on screen.
    private static func composite(_ drawing: CGImage, over background: (image: CGImage, scale: CGFloat)?,
                                  points: CGSize) -> CGImage {
        let width = drawing.width
        let height = drawing.height
        let space = background?.image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil }
            ?? CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return drawing }
        if let background {
            let scale = CGFloat(width) / max(1, points.width)
            let w = CGFloat(background.image.width) / background.scale * scale
            let h = CGFloat(background.image.height) / background.scale * scale
            ctx.draw(background.image, in: CGRect(x: 0, y: CGFloat(height) - h, width: w, height: h))
        }
        ctx.draw(drawing, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage() ?? drawing
    }

    // MARK: Search (⌥⇧D)

    @objc func openSearch() {
        if isShown { hide() }
        guard let url = URL(string: "raycast://extensions/moulik/screen-utils/search"),
              NSWorkspace.shared.open(url) else {
            NSLog("ScreenUtils: could not open Raycast")
            return
        }
    }

    // MARK: Hotkeys (⌥G, ⌥⇧S, ⌥⇧D)

    private func registerHotKeys() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let userData, let event else { return noErr }
            var hotKey = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
            let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async {
                switch hotKey.id {
                case 1: delegate.toggle()
                case 2: delegate.capture()
                case 3: delegate.openSearch()
                default: break
                }
            }
            return noErr
        }, 1, &eventType, selfPtr, nil)

        let keys: [(key: Int, modifiers: Int, name: String)] = [
            (kVK_ANSI_G, optionKey, "⌥G"),
            (kVK_ANSI_S, optionKey | shiftKey, "⌥⇧S"),
            (kVK_ANSI_D, optionKey | shiftKey, "⌥⇧D"),
        ]
        for (index, hotKey) in keys.enumerated() {
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: OSType(0x5344_5257), id: UInt32(index + 1)) // "SDRW"
            let status = RegisterEventHotKey(UInt32(hotKey.key), UInt32(hotKey.modifiers), id,
                                             GetApplicationEventTarget(), 0, &ref)
            if status != noErr || ref == nil {
                NSLog("ScreenUtils: could not register \(hotKey.name) (status \(status))")
            } else if let ref {
                hotKeyRefs.append(ref)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
