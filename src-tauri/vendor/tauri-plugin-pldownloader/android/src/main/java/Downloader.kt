package com.plugin.pldownloader

import android.app.Activity
import android.os.Environment
import android.net.Uri
import android.provider.MediaStore
import android.content.ContentValues
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke

@InvokeArg
class PingArgs {
  var value: String? = null
}

@TauriPlugin
class DownloaderPlugin(private val activity: Activity): Plugin(activity) {

    @Command
    fun ping(invoke: Invoke) {
        val args = invoke.parseArgs(PingArgs::class.java)

        val ret = JSObject()
        ret.put("value", args.value)
        invoke.resolve(ret)
    }

    @InvokeArg
    class DownloadPrivateArgs {
        var url: String? = null
        var fileName: String? = null
    }

    @InvokeArg
    class DownloadPublicArgs {
        var url: String? = null
        var fileName: String? = null
        var mimeType: String? = null
    }

    @InvokeArg
    class SaveFilePrivateFromBufferArgs {
        var data: ByteArray? = null
        var fileName: String? = null
    }

    @InvokeArg
    class SaveFilePublicFromBufferArgs {
        var data: ByteArray? = null
        var fileName: String? = null
        var mimeType: String? = null
    }

    @InvokeArg
    class SaveFileFromPathArgs {
        var path: String? = null
        var fileName: String? = null
        var mimeType: String? = null
    }

    @Command
    fun downloadPrivate(invoke: Invoke) {
        val args = invoke.parseArgs(DownloadPrivateArgs::class.java)
        val url = args.url
        if (url.isNullOrBlank()) {
            invoke.reject("Missing url")
            return
        }
        
        Thread {
            val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.getExternalFilesDir(null)
            if (dir == null) {
                activity.runOnUiThread {
                    invoke.reject("External files directory not available")
                }
                return@Thread
            }
            if (!dir.exists()) dir.mkdirs()

            val fileName = args.fileName ?: URL(url).path.substringAfterLast('/') .ifBlank { "download" }
            val outFile = File(dir, fileName)

            try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connect()
                if (connection.responseCode !in 200..299) {
                    activity.runOnUiThread {
                        invoke.reject("HTTP ${'$'}{connection.responseCode}")
                    }
                    connection.disconnect()
                    return@Thread
                }
                connection.inputStream.use { input ->
                    FileOutputStream(outFile).use { output ->
                        input.copyTo(output)
                    }
                }
                connection.disconnect()

                val ret = JSObject()
                ret.put("fileName", fileName)
                ret.put("path", outFile.absolutePath)
                activity.runOnUiThread {
                    invoke.resolve(ret)
                }
            } catch (e: Exception) {
                Log.e("DownloaderPlugin", "Download failed", e)
                e.printStackTrace()
                activity.runOnUiThread {
                    invoke.reject(e.message ?: "Download failed")
                }
            }
        }.start()
    }

    @Command
    fun downloadPublic(invoke: Invoke) {
        val args = invoke.parseArgs(DownloadPublicArgs::class.java)
        val url = args.url
        if (url.isNullOrBlank()) {
            invoke.reject("Missing url")
            return
        }
        
        Thread {
            val appName = activity.applicationInfo.loadLabel(activity.packageManager).toString()
            val subDir = Environment.DIRECTORY_DOWNLOADS + File.separator + appName

            val fileName = args.fileName ?: URL(url).path.substringAfterLast('/').ifBlank { "download" }
            val mime = args.mimeType ?: "application/octet-stream"

            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, subDir)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }

            val resolver = activity.contentResolver
            val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
            val uri: Uri? = resolver.insert(collection, values)
            if (uri == null) {
                activity.runOnUiThread {
                    invoke.reject("Failed to create media store entry")
                }
                return@Thread
            }

            try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connect()
                if (connection.responseCode !in 200..299) {
                    resolver.delete(uri, null, null)
                    activity.runOnUiThread {
                        invoke.reject("HTTP ${'$'}{connection.responseCode}")
                    }
                    connection.disconnect()
                    return@Thread
                }

                resolver.openOutputStream(uri)?.use { output ->
                    connection.inputStream.use { input ->
                        input.copyTo(output)
                    }
                } ?: run {
                    resolver.delete(uri, null, null)
                    activity.runOnUiThread {
                        invoke.reject("Failed to open output stream")
                    }
                    connection.disconnect()
                    return@Thread
                }

                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                connection.disconnect()

                val ret = JSObject()
                ret.put("fileName", fileName)
                ret.put("uri", uri.toString())
                activity.runOnUiThread {
                    invoke.resolve(ret)
                }
            } catch (e: Exception) {
                Log.e("DownloaderPlugin", "Download failed", e)
                e.printStackTrace()
                resolver.delete(uri, null, null)
                activity.runOnUiThread {
                    invoke.reject(e.message ?: "Download failed")
                }
            }
        }.start()
    }

    @Command
    fun saveFilePrivateFromBuffer(invoke: Invoke) {
        val args = invoke.parseArgs(SaveFilePrivateFromBufferArgs::class.java)
        val data = args.data
        val fileName = args.fileName
        if (data == null || fileName.isNullOrBlank()) {
            invoke.reject("Missing data or fileName")
            return
        }

        Thread {
            val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.getExternalFilesDir(null)
            if (dir == null) {
                activity.runOnUiThread { invoke.reject("External files directory not available") }
                return@Thread
            }
            if (!dir.exists()) dir.mkdirs()

            val dest = File(dir, fileName)
            try {
                FileOutputStream(dest).use { output ->
                    output.write(data)
                }

                val ret = JSObject()
                ret.put("fileName", dest.name)
                ret.put("path", dest.absolutePath)
                activity.runOnUiThread { invoke.resolve(ret) }
            } catch (e: Exception) {
                Log.e("DownloaderPlugin", "saveFilePrivateFromBuffer failed", e)
                activity.runOnUiThread { invoke.reject(e.message ?: "save failed") }
            }
        }.start()
    }

    @Command
    fun saveFilePublicFromBuffer(invoke: Invoke) {
        val args = invoke.parseArgs(SaveFilePublicFromBufferArgs::class.java)
        val data = args.data
        val fileName = args.fileName
        val mime = args.mimeType ?: "application/octet-stream"
        if (data == null || fileName.isNullOrBlank()) {
            invoke.reject("Missing data or fileName")
            return
        }

        Thread {
            val appName = activity.applicationInfo.loadLabel(activity.packageManager).toString()
            val subDir = Environment.DIRECTORY_DOWNLOADS + File.separator + appName

            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, subDir)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = activity.contentResolver
            val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
            val uri: Uri? = resolver.insert(collection, values)
            if (uri == null) {
                activity.runOnUiThread { invoke.reject("Failed to create media store entry") }
                return@Thread
            }

            try {
                resolver.openOutputStream(uri)?.use { output ->
                    output.write(data)
                } ?: run {
                    resolver.delete(uri, null, null)
                    activity.runOnUiThread { invoke.reject("Failed to open output stream") }
                    return@Thread
                }

                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)

                val ret = JSObject()
                ret.put("fileName", fileName)
                ret.put("uri", uri.toString())
                activity.runOnUiThread { invoke.resolve(ret) }
            } catch (e: Exception) {
                Log.e("DownloaderPlugin", "saveFilePublicFromBuffer failed", e)
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                activity.runOnUiThread { invoke.reject(e.message ?: "save failed") }
            }
        }.start()
    }

    @Command
    fun saveFilePublicFromPath(invoke: Invoke) {
        val args = invoke.parseArgs(SaveFileFromPathArgs::class.java)
        val path = args.path
        val fileName = args.fileName
        val mime = args.mimeType ?: "application/octet-stream"
        if (path.isNullOrBlank() || fileName.isNullOrBlank()) {
            invoke.reject("Missing path or fileName")
            return
        }

        Thread {
            val resolver = activity.contentResolver
            val uri: Uri? = try {
                val appName = activity.applicationInfo.loadLabel(activity.packageManager).toString()
                val subDir = Environment.DIRECTORY_DOWNLOADS + File.separator + appName
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, subDir)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            } catch (e: Exception) {
                Log.e("DownloaderPlugin", "saveFilePublicFromPath insert failed", e)
                null
            }

            if (uri == null) {
                activity.runOnUiThread { invoke.reject("Failed to create media store entry") }
                return@Thread
            }

            try {
                FileInputStream(File(path)).use { input ->
                    resolver.openOutputStream(uri)?.use { output ->
                        input.copyTo(output)
                    } ?: run {
                        resolver.delete(uri, null, null)
                        activity.runOnUiThread { invoke.reject("Failed to open output stream") }
                        return@Thread
                    }
                }

                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(uri, values, null, null)

                val ret = JSObject()
                ret.put("fileName", fileName)
                ret.put("uri", uri.toString())
                activity.runOnUiThread { invoke.resolve(ret) }
            } catch (e: Exception) {
                Log.e("DownloaderPlugin", "saveFilePublicFromPath failed", e)
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                activity.runOnUiThread { invoke.reject(e.message ?: "save failed") }
            }
        }.start()
    }
}
