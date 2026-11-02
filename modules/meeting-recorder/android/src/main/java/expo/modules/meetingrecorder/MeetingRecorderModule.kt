package expo.modules.meetingrecorder

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MeetingRecorderModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("MeetingRecorder")

    Function("start") { path: String ->
      val intent = Intent(context, RecorderService::class.java)
        .setAction(RecorderService.ACTION_START)
        .putExtra(RecorderService.EXTRA_PATH, path.removePrefix("file://"))
      ContextCompat.startForegroundService(context, intent)
    }

    AsyncFunction("stop") {
      val (path, durationMs) = RecorderService.stopAndWait()
      context.stopService(Intent(context, RecorderService::class.java))
      mapOf("path" to path, "durationMs" to durationMs)
    }

    Function("getStatus") {
      mapOf(
        "isRecording" to RecorderService.isRecording,
        "path" to RecorderService.currentPath,
        "startedAt" to RecorderService.startedAt,
        "durationMs" to RecorderService.bytesWritten * 1000 / (RecorderService.SAMPLE_RATE * 2),
        "level" to RecorderService.level
      )
    }
  }
}
