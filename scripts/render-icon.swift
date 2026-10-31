// Rasterizes an SVG to a square PNG at an exact pixel size, using AppKit's
// built-in SVG support:  swift scripts/render-icon.swift in.svg out.png 512
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let px = Int(args[3]),
      let image = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("usage: render-icon.swift in.svg out.png <pixels>\n".data(using: .utf8)!)
    exit(1)
}
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: px, height: px)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
image.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
