// 本地识字（macOS Vision，零下载零 token）。用法：ocr [--lang zh-Hans,en-US] <图片路径...>
// 每张图前打一行 "@@@<路径>" 标记，Node 侧按标记切段；图内文字按从上到下、从左到右排。
import Foundation
import Vision
import CoreGraphics
import ImageIO

var langs = ["zh-Hans", "en-US"]
var files: [String] = []
var argv = Array(CommandLine.arguments.dropFirst())
while let a = argv.first {
    if a == "--lang" {
        guard argv.count > 1 else { FileHandle.standardError.write("--lang 后面要跟逗号分隔的语言\n".data(using: .utf8)!); exit(2) }
        langs = argv[1].split(separator: ",").map(String.init)
        argv = Array(argv.dropFirst(2))
    } else {
        files.append(a)
        argv = Array(argv.dropFirst())
    }
}
if files.isEmpty {
    FileHandle.standardError.write("用法: ocr [--lang zh-Hans,en-US] <图片路径...>\n".data(using: .utf8)!)
    exit(2)
}

func load(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

for path in files {
    print("@@@\(path)")
    guard let cg = load(path) else {
        FileHandle.standardError.write("读不到图片：\(path)\n".data(using: .utf8)!)
        continue
    }
    var lines: [String] = []
    let req = VNRecognizeTextRequest { request, _ in
        let obs = (request.results as? [VNRecognizedTextObservation]) ?? []
        // Vision 的 y 轴朝上；先按行高把同一行的碎片归一组，再自上而下、组内自左而右拼
        let rows = obs.compactMap { o -> (y: CGFloat, x: CGFloat, h: CGFloat, t: String)? in
            guard let t = o.topCandidates(1).first else { return nil }
            return (o.boundingBox.midY, o.boundingBox.minX, max(o.boundingBox.height, 0.01), t.string)
        }
        var groups: [[(y: CGFloat, x: CGFloat, h: CGFloat, t: String)]] = []
        for r in rows.sorted(by: { $0.y > $1.y }) {
            let i = groups.count - 1
            if i >= 0, let last = groups[i].last, abs(last.y - r.y) < max(last.h, r.h) * 0.6 { groups[i].append(r) }
            else { groups.append([r]) }
        }
        lines = groups.map { $0.sorted { $0.x < $1.x }.map(\.t).joined(separator: " ") }
    }
    req.recognitionLevel = .accurate
    req.recognitionLanguages = langs
    req.usesLanguageCorrection = true
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    } catch {
        FileHandle.standardError.write("OCR 失败 \(path)：\(error)\n".data(using: .utf8)!)
    }
    for l in lines { print(l) }
}
