package expo.modules.meetingrecorder

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.StatFs
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Model files live in the app's external files dir and are downloaded by the system
 * DownloadManager, which resumes after network drops and keeps going in the background.
 */
class ModelFilesModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val modelsDir: File
    get() = (context.getExternalFilesDir("models") ?: File(context.filesDir, "models")).also { it.mkdirs() }

  private val downloads: DownloadManager
    get() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  override fun definition() = ModuleDefinition {
    Name("ModelFiles")

    Function("getModelsDir") { modelsDir.absolutePath }

    Function("getTotalRamBytes") {
      val info = android.app.ActivityManager.MemoryInfo()
      (context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager).getMemoryInfo(info)
      info.totalMem.toDouble()
    }

    Function("getFreeBytes") { StatFs(modelsDir.absolutePath).availableBytes.toDouble() }

    Function("fileSize") { path: String ->
      val f = File(path.removePrefix("file://"))
      if (f.isFile) f.length().toDouble() else -1.0
    }

    Function("deleteFile") { path: String ->
      File(path.removePrefix("file://")).delete()
    }

    Function("startDownload") { url: String, fileName: String, title: String ->
      File(modelsDir, fileName).delete()
      File(modelsDir, "$fileName.part").delete()
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .setDescription("Модель для работы без интернета")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationUri(Uri.fromFile(File(modelsDir, "$fileName.part")))
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(false)
      downloads.enqueue(request).toString()
    }

    /** Status of a download; on success the .part file is renamed to its final name. */
    Function("getDownload") { id: String, fileName: String ->
      val cursor = downloads.query(DownloadManager.Query().setFilterById(id.toLong()))
      cursor.use {
        if (!it.moveToFirst()) return@Function mapOf("status" to "missing")
        val status = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        val done = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val total = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        val reason = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
        val name = when (status) {
          DownloadManager.STATUS_SUCCESSFUL -> {
            val part = File(modelsDir, "$fileName.part")
            if (part.exists()) part.renameTo(File(modelsDir, fileName))
            "done"
          }
          DownloadManager.STATUS_FAILED -> "failed"
          DownloadManager.STATUS_PAUSED -> "paused"
          DownloadManager.STATUS_PENDING -> "pending"
          else -> "running"
        }
        mapOf("status" to name, "bytes" to done.toDouble(), "total" to total.toDouble(), "reason" to reason)
      }
    }

    Function("cancelDownload") { id: String, fileName: String ->
      downloads.remove(id.toLong())
      File(modelsDir, "$fileName.part").delete()
    }

    /** Copies a file the user picked (content:// URI) into the models dir. */
    AsyncFunction("importFromUri") { uri: String, fileName: String ->
      val target = File(modelsDir, fileName)
      val tmp = File(modelsDir, "$fileName.part")
      context.contentResolver.openInputStream(Uri.parse(uri)).use { input ->
        requireNotNull(input) { "Не удалось открыть файл" }
        tmp.outputStream().use { input.copyTo(it, 1 shl 20) }
      }
      target.delete()
      tmp.renameTo(target)
      target.length().toDouble()
    }
  }
}
