import Cocoa
import Vision

// The screenshot library: PNGs in folders under one root (~/Pictures/Screen
// Utils by default, or `defaults write dev.moulik.screendraw libraryPath …`),
// plus `.screenutils.json` at the root with each file's note, tags and the
// text read off it. The Raycast extension reads and edits the same files.
//
// Folders are the root's subfolders, so one made in Finder shows up too. The
// index is keyed by path relative to the root. Every change reads the index
// fresh and writes it back atomically, so the app and the extension can both
// edit it. Keys this app doesn't know are kept.
final class Library {
    static let shared = Library()
    static let indexName = ".screenutils.json"

    private let queue = DispatchQueue(label: "dev.moulik.screenutils.library", qos: .userInitiated)

    var root: URL {
        if let custom = UserDefaults.standard.string(forKey: "libraryPath"), !custom.isEmpty {
            return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
        }
        let pictures = FileManager.default.urls(for: .picturesDirectory, in: .userDomainMask)[0]
        return pictures.appendingPathComponent("Screen Utils", isDirectory: true)
    }

    private var indexURL: URL { root.appendingPathComponent(Library.indexName) }

    // MARK: Index

    private func readItems() -> [String: [String: Any]] {
        guard let data = try? Data(contentsOf: indexURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["items"] as? [String: [String: Any]] else { return [:] }
        return items
    }

    private func writeItems(_ items: [String: [String: Any]]) throws {
        let json: [String: Any] = ["version": 1, "items": items]
        let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try data.write(to: indexURL, options: .atomic)
    }

    private func updateItem(_ path: String, _ change: (inout [String: Any]) -> Void) {
        var items = readItems()
        var item = items[path] ?? [:]
        change(&item)
        items[path] = item
        do { try writeItems(items) } catch { NSLog("ScreenUtils: could not save the library index: \(error)") }
    }

    // MARK: Suggestions for the note bar

    private func folderNames() -> [String] {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        return urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
            .map(\.lastPathComponent)
    }

    // Folders, most recently used first, and tags, most used first.
    func suggestions() -> [String: [String]] {
        let items = readItems()
        var folderLast: [String: Double] = [:]
        var tagCount: [String: (count: Int, last: Double)] = [:]
        for (path, item) in items {
            let created = item["createdAt"] as? Double ?? 0
            let parts = path.split(separator: "/")
            if parts.count > 1 { folderLast[String(parts[0])] = max(folderLast[String(parts[0])] ?? 0, created) }
            for tag in item["tags"] as? [String] ?? [] {
                let old = tagCount[tag] ?? (0, 0)
                tagCount[tag] = (old.count + 1, max(old.last, created))
            }
        }
        let folders = folderNames().sorted {
            let a = folderLast[$0] ?? 0, b = folderLast[$1] ?? 0
            return a != b ? a > b : $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
        let tags = tagCount.sorted {
            $0.value.count != $1.value.count ? $0.value.count > $1.value.count : $0.value.last > $1.value.last
        }.map(\.key)
        return ["folders": folders, "tags": tags]
    }

    // MARK: Saving

    // Names typed after @ have no spaces, so "my-folder" also finds "My Folder".
    static func normalized(_ name: String) -> String {
        name.lowercased().replacingOccurrences(of: "[\\s_-]+", with: "-", options: .regularExpression)
    }

    private func resolveFolder(_ typed: String?) -> String? {
        guard let typed = typed?.trimmingCharacters(in: .whitespacesAndNewlines), !typed.isEmpty else { return nil }
        let key = Library.normalized(typed)
        if let existing = folderNames().first(where: { Library.normalized($0) == key }) { return existing }
        var name = typed.replacingOccurrences(of: "[/:]", with: "-", options: .regularExpression)
        while name.hasPrefix(".") { name.removeFirst() }
        name = String(name.prefix(64))
        return name.isEmpty ? nil : name
    }

    private func resolveTags(_ typed: [String]) -> [String] {
        var known: [String: String] = [:]
        for tag in suggestions()["tags"] ?? [] { known[Library.normalized(tag)] = known[Library.normalized(tag)] ?? tag }
        var seen = Set<String>()
        var tags: [String] = []
        for raw in typed {
            let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = Library.normalized(tag)
            guard !tag.isEmpty, seen.insert(key).inserted else { continue }
            tags.append(known[key] ?? tag)
        }
        return tags
    }

    private static let nameFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return f
    }()

    // Writes the image as a PNG and records it. `kind` is "screenshot" or
    // "drawing". The text in the image is read afterwards and added to the
    // index so searches find it.
    func save(_ image: CGImage, kind: String, note: String, folder: String?, tags: [String]) {
        let date = Date()
        queue.async { [self] in
            let folder = resolveFolder(folder)
            let tags = resolveTags(tags)
            let dir = folder.map { root.appendingPathComponent($0, isDirectory: true) } ?? root
            let base = "\(kind == "drawing" ? "Drawing" : "Screenshot") \(Library.nameFormat.string(from: date))"
            let url = Library.freeURL(in: dir, name: base + ".png")
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                NSLog("ScreenUtils: could not create \(dir.path): \(error)")
                return
            }
            guard let file = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
                NSLog("ScreenUtils: could not save the screenshot")
                return
            }
            CGImageDestinationAddImage(file, image, nil)
            guard CGImageDestinationFinalize(file) else {
                NSLog("ScreenUtils: could not save the screenshot")
                return
            }
            let path = folder.map { "\($0)/\(url.lastPathComponent)" } ?? url.lastPathComponent
            updateItem(path) { item in
                item["kind"] = kind
                item["note"] = note
                item["tags"] = tags
                item["createdAt"] = (date.timeIntervalSince1970 * 1000).rounded()
                item["width"] = image.width
                item["height"] = image.height
            }
            NSLog("ScreenUtils: saved \(path)")
            // Reading the text takes a moment; the next save needn't wait for it.
            DispatchQueue.global(qos: .utility).async { [self] in
                storeText(recognizeText(in: image), for: path)
            }
        }
    }

    // `text` is stored even when empty, so an image is only read once.
    private func storeText(_ text: String, for path: String) {
        queue.async { [self] in
            // Unless the extension has moved or deleted it since.
            guard FileManager.default.fileExists(atPath: root.appendingPathComponent(path).path) else { return }
            updateItem(path) { $0["text"] = text }
        }
    }

    private static func freeURL(in dir: URL, name: String) -> URL {
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        var url = dir.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent("\(base) (\(n))" + (ext.isEmpty ? "" : ".\(ext)"))
            n += 1
        }
        return url
    }

    // MARK: Reading text in older images

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "gif", "webp", "tif", "tiff"]
    private var readingText = false

    // Images in the library, as paths relative to the root.
    private func imagePaths() -> [String] {
        let fm = FileManager.default
        let isImage = { (name: String) in
            !name.hasPrefix(".") && Library.imageExtensions.contains((name as NSString).pathExtension.lowercased())
        }
        var paths: [String] = []
        for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where !name.hasPrefix(".") {
            var isDir: ObjCBool = false
            fm.fileExists(atPath: root.appendingPathComponent(name).path, isDirectory: &isDir)
            if isDir.boolValue {
                let sub = (try? fm.contentsOfDirectory(atPath: root.appendingPathComponent(name).path)) ?? []
                paths += sub.filter(isImage).map { "\(name)/\($0)" }
            } else if isImage(name) {
                paths.append(name)
            }
        }
        return paths
    }

    // Reads the text in images that don't have it yet: ones dropped into the
    // library in Finder, or saved before the app quit mid-read. One at a time,
    // in the background.
    func readMissingText() {
        queue.async { [self] in
            guard !readingText else { return }
            let items = readItems()
            let missing = imagePaths().filter { items[$0]?["text"] == nil }
            guard !missing.isEmpty else { return }
            readingText = true
            NSLog("ScreenUtils: reading text in \(missing.count) images")
            DispatchQueue.global(qos: .utility).async { [self] in
                for path in missing {
                    let url = root.appendingPathComponent(path)
                    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
                    storeText(recognizeText(in: image), for: path)
                }
                queue.async { [self] in readingText = false }
            }
        }
    }

    // MARK: Editing

    struct Entry {
        let path: String // relative to the root
        let note: String
        let folder: String?
        let tags: [String]
    }

    // The library's record of an image file, if the file is in the library.
    func entry(forFile file: URL) -> Entry? {
        let rootPath = root.resolvingSymlinksInPath().path + "/"
        let filePath = file.standardizedFileURL.resolvingSymlinksInPath().path
        guard filePath.hasPrefix(rootPath), FileManager.default.fileExists(atPath: filePath) else { return nil }
        let path = String(filePath.dropFirst(rootPath.count))
        let parts = path.split(separator: "/").map(String.init)
        guard (1...2).contains(parts.count), !parts.contains(where: { $0.hasPrefix(".") }) else { return nil }
        let item = readItems()[path] ?? [:]
        return Entry(path: path, note: item["note"] as? String ?? "",
                     folder: parts.count == 2 ? parts[0] : nil, tags: item["tags"] as? [String] ?? [])
    }

    // Changes an image's note, tags and folder. A new folder moves the file.
    func update(_ path: String, note: String, folder typedFolder: String?, tags typedTags: [String]) {
        queue.async { [self] in
            let folder = resolveFolder(typedFolder)
            let tags = resolveTags(typedTags)
            let old = root.appendingPathComponent(path)
            let created = try? old.resourceValues(forKeys: [.creationDateKey]).creationDate
            let parts = path.split(separator: "/").map(String.init)
            var newPath = path
            if folder != (parts.count == 2 ? parts[0] : nil) {
                let dir = folder.map { root.appendingPathComponent($0, isDirectory: true) } ?? root
                let url = Library.freeURL(in: dir, name: old.lastPathComponent)
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try FileManager.default.moveItem(at: old, to: url)
                } catch {
                    NSLog("ScreenUtils: could not move \(path): \(error)")
                    return
                }
                newPath = folder.map { "\($0)/\(url.lastPathComponent)" } ?? url.lastPathComponent
            }
            var items = readItems()
            var item = items.removeValue(forKey: path) ?? [:]
            if item["createdAt"] == nil, let created {
                item["createdAt"] = (created.timeIntervalSince1970 * 1000).rounded()
            }
            item["note"] = note
            item["tags"] = tags
            items[newPath] = item
            do { try writeItems(items) } catch { NSLog("ScreenUtils: could not save the library index: \(error)") }
            NSLog("ScreenUtils: edited \(newPath)")
        }
    }

    private func recognizeText(in image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            NSLog("ScreenUtils: could not read text from the screenshot: \(error)")
            return ""
        }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
