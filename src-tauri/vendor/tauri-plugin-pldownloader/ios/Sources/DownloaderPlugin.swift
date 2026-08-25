import SwiftRs
import Tauri
import UIKit
import WebKit
import Photos
import UniformTypeIdentifiers

class PingArgs: Decodable {
  let value: String?
}

class DownloaderPlugin: Plugin {
  @objc public func ping(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PingArgs.self)
    invoke.resolve(["value": args.value ?? ""])
  }

  // MARK: - Models
  class DownloadPrivateArgs: Decodable {
    let url: String
    let fileName: String?
  }

  class DownloadPublicArgs: Decodable {
    let url: String
    let fileName: String?
    let mimeType: String?
  }

  class SaveFilePrivateFromBufferArgs: Decodable {
    let data: Data
    let fileName: String
    
    private enum CodingKeys: String, CodingKey {
      case data, fileName
    }
    
    required init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      fileName = try container.decode(String.self, forKey: .fileName)
      
      // Handle ArrayBuffer as array of UInt8
      if let dataArray = try? container.decode([UInt8].self, forKey: .data) {
        data = Data(dataArray)
      } else {
        // Fallback to direct Data decoding
        data = try container.decode(Data.self, forKey: .data)
      }
    }
  }

  class SaveFilePublicFromBufferArgs: Decodable {
    let data: Data
    let fileName: String
    let mimeType: String?
    
    private enum CodingKeys: String, CodingKey {
      case data, fileName, mimeType
    }
    
    required init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      fileName = try container.decode(String.self, forKey: .fileName)
      mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType)
      
      // Handle ArrayBuffer as array of UInt8
      if let dataArray = try? container.decode([UInt8].self, forKey: .data) {
        data = Data(dataArray)
      } else {
        // Fallback to direct Data decoding
        data = try container.decode(Data.self, forKey: .data)
      }
    }
  }

  // Path-based public save: imports an already-written file (e.g. streamed to the app
  // sandbox by the JS side) into the photo library. Keeps the whole content out of
  // WebKit/IPC memory → avoids iOS long-video crash.
  class SaveFileFromPathArgs: Decodable {
    let path: String
    let fileName: String
    let mimeType: String?
  }

  // MARK: - Public Commands
  @objc public func downloadPrivate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DownloadPrivateArgs.self)

    guard let remoteUrl = URL(string: args.url) else {
      return invoke.reject("Invalid url")
    }

    let fileName = self.resolveFileName(from: args.fileName, fallbackUrl: remoteUrl)

    URLSession.shared.downloadTask(with: remoteUrl) { tempUrl, response, error in
      if let error = error {
        return invoke.reject(error.localizedDescription)
      }

      guard let tempUrl = tempUrl else {
        return invoke.reject("Empty response")
      }

      do {
        let directory = try self.ensureApplicationSupportSubdir("Downloads")
        let destinationUrl = self.uniqueDestination(for: directory, preferredFileName: fileName)
        try FileManager.default.moveItem(at: tempUrl, to: destinationUrl)

        invoke.resolve([
          "fileName": destinationUrl.lastPathComponent,
          "path": destinationUrl.path
        ])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }.resume()
  }

  @objc public func downloadPublic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DownloadPublicArgs.self)

    guard let remoteUrl = URL(string: args.url) else {
      return invoke.reject("Invalid url")
    }

    let fileName = self.resolveFileName(from: args.fileName, fallbackUrl: remoteUrl)
    URLSession.shared.downloadTask(with: remoteUrl) { tempUrl, response, error in
      if let error = error {
        return invoke.reject(error.localizedDescription)
      }

      guard let tempUrl = tempUrl else {
        return invoke.reject("Empty response")
      }

      // Decide media vs document
      let contentType = args.mimeType
        ?? (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")
      let isMedia = self.isImageOrVideo(mimeType: contentType, fileName: fileName)

      if isMedia {
        // Move temp file to a persistent location to avoid URLSession cleanup during Photos save
        do {
          let cacheDir = try self.ensureCachesSubdir("Downloads")
          let persistentUrl = self.uniqueDestination(for: cacheDir, preferredFileName: fileName)
          try FileManager.default.moveItem(at: tempUrl, to: persistentUrl)

          self.saveToPhotoLibrary(fromPersistentUrl: persistentUrl, fileName: fileName) { result in
            // Best-effort cleanup; Photos should move the file when shouldMoveFile = true
            try? FileManager.default.removeItem(at: persistentUrl)
            switch result {
            case .success(let localIdentifier):
              invoke.resolve([
                "fileName": fileName,
                "uri": localIdentifier
              ])
            case .failure(let err):
              invoke.reject(err.localizedDescription)
            }
          }
        } catch {
          invoke.reject(error.localizedDescription)
        }
      } else {
        do {
          let documentsDir = try self.ensureDocumentsSubdir(self.appDisplayName())
          let destinationUrl = self.uniqueDestination(for: documentsDir, preferredFileName: fileName)
          try FileManager.default.moveItem(at: tempUrl, to: destinationUrl)
          invoke.resolve([
            "fileName": destinationUrl.lastPathComponent,
            "path": destinationUrl.path
          ])
        } catch {
          invoke.reject(error.localizedDescription)
        }
      }
    }.resume()
  }

  @objc public func saveFilePrivateFromBuffer(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SaveFilePrivateFromBufferArgs.self)

    let data = args.data
    let fileName = args.fileName

    do {
      let directory = try self.ensureApplicationSupportSubdir("Downloads")
      let destinationUrl = self.uniqueDestination(for: directory, preferredFileName: fileName)
      try data.write(to: destinationUrl)

      invoke.resolve([
        "fileName": destinationUrl.lastPathComponent,
        "path": destinationUrl.path
      ])
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }

  @objc public func saveFilePublicFromBuffer(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SaveFilePublicFromBufferArgs.self)

    let data = args.data
    let fileName = args.fileName
    let isMedia = self.isImageOrVideo(mimeType: args.mimeType, fileName: fileName)

    if isMedia {
      do {
        let cacheDir = try self.ensureCachesSubdir("Downloads")
        let persistentUrl = self.uniqueDestination(for: cacheDir, preferredFileName: fileName)
        try data.write(to: persistentUrl)

        self.saveToPhotoLibrary(fromPersistentUrl: persistentUrl, fileName: fileName) { result in
          try? FileManager.default.removeItem(at: persistentUrl)
          switch result {
          case .success(let localIdentifier):
            invoke.resolve([
              "fileName": fileName,
              "uri": localIdentifier
            ])
          case .failure(let err):
            invoke.reject(err.localizedDescription)
          }
        }
      } catch {
        invoke.reject(error.localizedDescription)
      }
    } else {
      do {
        let documentsDir = try self.ensureDocumentsSubdir(self.appDisplayName())
        let destinationUrl = self.uniqueDestination(for: documentsDir, preferredFileName: fileName)
        try data.write(to: destinationUrl)
        invoke.resolve([
          "fileName": destinationUrl.lastPathComponent,
          "path": destinationUrl.path
        ])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // MARK: - Path-based public save (long videos, keeps bytes out of WebKit/IPC)
  @objc public func saveFilePublicFromPath(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SaveFileFromPathArgs.self)
    let url = URL(fileURLWithPath: args.path)
    let isMedia = self.isImageOrVideo(mimeType: args.mimeType, fileName: args.fileName)

    if isMedia {
      self.saveToPhotoLibrary(fromPersistentUrl: url, fileName: args.fileName) { result in
        switch result {
        case .success(let localIdentifier):
          invoke.resolve([
            "fileName": args.fileName,
            "uri": localIdentifier
          ])
        case .failure(let err):
          invoke.reject(err.localizedDescription)
        }
      }
    } else {
      do {
        let documentsDir = try self.ensureDocumentsSubdir(self.appDisplayName())
        let destinationUrl = self.uniqueDestination(for: documentsDir, preferredFileName: args.fileName)
        try FileManager.default.moveItem(at: url, to: destinationUrl)
        invoke.resolve([
          "fileName": destinationUrl.lastPathComponent,
          "path": destinationUrl.path
        ])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // MARK: - Helpers
  private func appDisplayName() -> String {
    let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
    return name ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "App")
  }

  private func ensureApplicationSupportSubdir(_ subdir: String) throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let dir = base.appendingPathComponent(subdir, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
    return dir
  }

  private func ensureDocumentsSubdir(_ subdir: String) throws -> URL {
    let base = try FileManager.default.url(
      for: .documentDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let dir = base.appendingPathComponent(subdir, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
    return dir
  }

  private func ensureCachesSubdir(_ subdir: String) throws -> URL {
    let base = try FileManager.default.url(
      for: .cachesDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let dir = base.appendingPathComponent(subdir, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: nil)
    return dir
  }

  private func resolveFileName(from preferred: String?, fallbackUrl: URL) -> String {
    if let name = preferred, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return name
    }
    let last = fallbackUrl.lastPathComponent
    if !last.isEmpty { return last }
    return "download"
  }

  private func uniqueDestination(for directory: URL, preferredFileName: String) -> URL {
    let preferred = preferredFileName.isEmpty ? "download" : preferredFileName
    let url = directory.appendingPathComponent(preferred)
    if !FileManager.default.fileExists(atPath: url.path) {
      return url
    }

    let name = (preferred as NSString).deletingPathExtension
    let ext = (preferred as NSString).pathExtension
    var index = 1
    while true {
      let candidateName = ext.isEmpty ? "\(name) (\(index))" : "\(name) (\(index)).\(ext)"
      let candidate = directory.appendingPathComponent(candidateName)
      if !FileManager.default.fileExists(atPath: candidate.path) {
        return candidate
      }
      index += 1
    }
  }

  private func isImageOrVideo(mimeType: String?, fileName: String) -> Bool {
    // Prefer explicit mime
    if let mt = mimeType?.lowercased() {
      if mt.hasPrefix("image/") || mt.hasPrefix("video/") { return true }
    }

    // Fallback by extension using UTType
    if #available(iOS 14.0, *) {
      let ext = (fileName as NSString).pathExtension
      if let type = UTType(filenameExtension: ext) {
      if type.conforms(to: .image) || type.conforms(to: .movie) {
          return true
        }
      }
    }
    return false
  }

  private func saveToPhotoLibrary(fromPersistentUrl url: URL, fileName: String, completion: @escaping (Result<String, Error>) -> Void) {
    let performSave = {
      var localId: String?
      PHPhotoLibrary.shared().performChanges({
        let creation = PHAssetCreationRequest.forAsset()
        let ext = (fileName as NSString).pathExtension.lowercased()
        let options = PHAssetResourceCreationOptions()
        options.shouldMoveFile = true
        options.originalFilename = fileName
        if ["mp4", "mov", "m4v", "avi", "mkv"].contains(ext) {
          creation.addResource(with: .video, fileURL: url, options: options)
        } else {
          creation.addResource(with: .photo, fileURL: url, options: options)
        }
        localId = creation.placeholderForCreatedAsset?.localIdentifier
      }, completionHandler: { success, error in
        if let error = error {
          return completion(.failure(error))
        }
        if success, let localId = localId {
          completion(.success(localId))
        } else {
          completion(.failure(NSError(domain: "DownloaderPlugin", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to save to Photos"])) )
        }
      })
    }

    if #available(iOS 14.0, *) {
      let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
      switch status {
      case .authorized, .limited: performSave()
      case .notDetermined:
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { newStatus in
          DispatchQueue.main.async {
            if newStatus == .authorized || newStatus == .limited {
              performSave()
            } else {
              completion(.failure(NSError(domain: "DownloaderPlugin", code: -2, userInfo: [NSLocalizedDescriptionKey: "Photo library add permission denied"])) )
            }
          }
        }
      default:
        completion(.failure(NSError(domain: "DownloaderPlugin", code: -2, userInfo: [NSLocalizedDescriptionKey: "Photo library add permission denied"])) )
      }
    } else {
      let status = PHPhotoLibrary.authorizationStatus()
      if status == .authorized {
        performSave()
      } else if status == .notDetermined {
        PHPhotoLibrary.requestAuthorization { newStatus in
          DispatchQueue.main.async {
            if newStatus == .authorized {
              performSave()
            } else {
              completion(.failure(NSError(domain: "DownloaderPlugin", code: -2, userInfo: [NSLocalizedDescriptionKey: "Photo library permission denied"])) )
            }
          }
        }
      } else {
        completion(.failure(NSError(domain: "DownloaderPlugin", code: -2, userInfo: [NSLocalizedDescriptionKey: "Photo library permission denied"])) )
      }
    }
  }
}

@_cdecl("init_plugin_pldownloader")
func initPlugin() -> Plugin {
  return DownloaderPlugin()
}
