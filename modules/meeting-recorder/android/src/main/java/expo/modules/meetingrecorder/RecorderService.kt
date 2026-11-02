package expo.modules.meetingrecorder

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File
import java.io.RandomAccessFile
import kotlin.math.sqrt

/**
 * Foreground service that records the microphone to a 16 kHz mono 16-bit WAV file,
 * the format whisper.cpp reads directly. Keeps recording with the screen off.
 */
class RecorderService : Service() {
  companion object {
    const val SAMPLE_RATE = 16000
    const val ACTION_START = "expo.modules.meetingrecorder.START"
    const val ACTION_STOP = "expo.modules.meetingrecorder.STOP"
    const val EXTRA_PATH = "path"
    private const val CHANNEL_ID = "meeting_recorder"
    private const val NOTIFICATION_ID = 4711

    @Volatile var isRecording = false
      private set
    @Volatile var currentPath: String? = null
      private set
    @Volatile var startedAt: Long = 0
      private set
    @Volatile var bytesWritten: Long = 0
      private set
    @Volatile var level: Float = 0f
      private set

    private var worker: Thread? = null

    /** Blocks until the recording thread has finished and the WAV header is final. */
    fun stopAndWait(): Pair<String?, Long> {
      isRecording = false
      worker?.join(5000)
      worker = null
      val durationMs = bytesWritten * 1000 / (SAMPLE_RATE * 2)
      return Pair(currentPath, durationMs)
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        val path = intent.getStringExtra(EXTRA_PATH) ?: return START_NOT_STICKY
        startForegroundCompat()
        startRecording(path)
      }
      ACTION_STOP -> {
        stopAndWait()
        stopSelfCompat()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (isRecording) stopAndWait()
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun stopSelfCompat() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun startForegroundCompat() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Запись встречи", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)
    val openPending = PendingIntent.getActivity(
      this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val stopPending = PendingIntent.getService(
      this, 1, Intent(this, RecorderService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Идёт запись встречи")
      .setContentText("Нажмите, чтобы открыть приложение")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setUsesChronometer(true)
      .setWhen(System.currentTimeMillis())
      .setContentIntent(openPending)
      .addAction(0, "Остановить", stopPending)
      .build()
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    } else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
  }

  @SuppressLint("MissingPermission", "WakelockTimeout")
  private fun startRecording(path: String) {
    if (isRecording) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MeetingRecorder::rec").also { it.acquire() }

    val minBuf = AudioRecord.getMinBufferSize(
      SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
    )
    val bufSize = maxOf(minBuf, SAMPLE_RATE) // ~0.5 s
    val record = AudioRecord(
      MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize
    )

    File(path).parentFile?.mkdirs()
    currentPath = path
    bytesWritten = 0
    startedAt = System.currentTimeMillis()
    isRecording = true

    worker = Thread {
      val out = RandomAccessFile(path, "rw")
      out.setLength(0)
      out.write(wavHeader(0))
      val buf = ShortArray(bufSize / 2)
      val bytes = ByteArray(buf.size * 2)
      var lastHeaderUpdate = System.currentTimeMillis()
      try {
        record.startRecording()
        while (isRecording) {
          val n = record.read(buf, 0, buf.size)
          if (n <= 0) continue
          var sum = 0.0
          for (i in 0 until n) {
            val s = buf[i].toInt()
            bytes[i * 2] = (s and 0xff).toByte()
            bytes[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
            sum += (s * s).toDouble()
          }
          level = (sqrt(sum / n) / 32768.0).toFloat()
          out.write(bytes, 0, n * 2)
          bytesWritten += n * 2
          // Keep the header valid so a crash still leaves a playable file.
          val now = System.currentTimeMillis()
          if (now - lastHeaderUpdate > 10_000) {
            writeHeader(out)
            lastHeaderUpdate = now
          }
        }
      } finally {
        try { record.stop() } catch (_: Exception) {}
        record.release()
        writeHeader(out)
        out.close()
        level = 0f
        wakeLock?.let { if (it.isHeld) it.release() }
      }
    }.also { it.start() }
  }

  private fun writeHeader(out: RandomAccessFile) {
    val pos = out.filePointer
    out.seek(0)
    out.write(wavHeader(bytesWritten))
    out.seek(pos)
  }

  private fun wavHeader(dataLen: Long): ByteArray {
    val byteRate = SAMPLE_RATE * 2
    val h = ByteArray(44)
    fun putStr(off: Int, s: String) = s.forEachIndexed { i, c -> h[off + i] = c.code.toByte() }
    fun putInt(off: Int, v: Long) { for (i in 0..3) h[off + i] = ((v shr (8 * i)) and 0xff).toByte() }
    fun putShort(off: Int, v: Int) { h[off] = (v and 0xff).toByte(); h[off + 1] = ((v shr 8) and 0xff).toByte() }
    putStr(0, "RIFF"); putInt(4, 36 + dataLen); putStr(8, "WAVE")
    putStr(12, "fmt "); putInt(16, 16); putShort(20, 1); putShort(22, 1)
    putInt(24, SAMPLE_RATE.toLong()); putInt(28, byteRate.toLong()); putShort(32, 2); putShort(34, 16)
    putStr(36, "data"); putInt(40, dataLen)
    return h
  }
}
