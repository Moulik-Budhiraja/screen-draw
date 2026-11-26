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
            var url = dir.appendingPathComponent(base + ".png")
            var n = 2
            while FileManager.default.fileExists(atPath: url.path) {
                url = dir.appendingPathComponent("\(base) (\(n)).png")
                n += 1
            }
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
                let text = recognizeText(in: image)
                guard !text.isEmpty else { return }
                queue.async { [self] in
                    // Unless the extension has moved or deleted it since.
                    guard readItems()[path] != nil else { return }
                    updateItem(path) { $0["text"] = text }
                }
            }
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
