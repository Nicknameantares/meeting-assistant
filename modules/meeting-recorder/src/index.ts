import { requireNativeModule } from 'expo-modules-core';

export type RecorderStatus = {
  isRecording: boolean;
  path: string | null;
  startedAt: number;
  durationMs: number;
  level: number;
};

type NativeRecorder = {
  start(path: string): void;
  stop(): Promise<{ path: string | null; durationMs: number }>;
  getStatus(): RecorderStatus;
};

const Native = requireNativeModule<NativeRecorder>('MeetingRecorder');

/** Starts recording a 16 kHz mono WAV file in a foreground service. */
export function startRecording(path: string) {
  Native.start(path);
}

export function stopRecording() {
  return Native.stop();
}

export function getRecorderStatus(): RecorderStatus {
  return Native.getStatus();
}

export type DownloadStatus = {
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'missing';
  bytes?: number;
  total?: number;
  reason?: number;
};

type NativeModelFiles = {
  getModelsDir(): string;
  getTotalRamBytes(): number;
  getFreeBytes(): number;
  fileSize(path: string): number;
  deleteFile(path: string): boolean;
  startDownload(url: string, fileName: string, title: string): string;
  getDownload(id: string, fileName: string): DownloadStatus;
  cancelDownload(id: string, fileName: string): void;
  importFromUri(uri: string, fileName: string): Promise<number>;
};

/** Model storage and downloads through the Android DownloadManager. */
export const ModelFiles = requireNativeModule<NativeModelFiles>('ModelFiles');
