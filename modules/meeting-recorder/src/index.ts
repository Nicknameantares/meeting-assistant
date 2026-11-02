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
