import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FS from 'expo-file-system/legacy';

export type MeetingStatus = 'recorded' | 'transcribing' | 'summarizing' | 'done' | 'error';

export type Meeting = {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  audioPath: string;
  status: MeetingStatus;
  transcript?: string;
  summary?: string;
  error?: string;
};

export type Settings = {
  whisperModelId: string;
  llmModelId: string;
  language: 'ru' | 'auto';
  /** cloud: GigaChat when online, the local model otherwise; local: always on the phone. */
  summaryMode: 'cloud' | 'local';
  cloudModel: string;
};

const MEETINGS_KEY = 'meetings.v1';
const SETTINGS_KEY = 'settings.v1';
const ACTIVE_KEY = 'activeRecording.v1';

export const RECORDINGS_DIR = `${FS.documentDirectory}recordings/`;

export const DEFAULT_SETTINGS: Settings = {
  whisperModelId: 'whisper-small',
  llmModelId: 'qwen3-4b',
  language: 'ru',
  summaryMode: 'cloud',
  cloudModel: 'GigaChat-2-Pro',
};

export async function loadMeetings(): Promise<Meeting[]> {
  const raw = await AsyncStorage.getItem(MEETINGS_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function saveMeetings(meetings: Meeting[]) {
  await AsyncStorage.setItem(MEETINGS_KEY, JSON.stringify(meetings));
}

export async function loadSettings(): Promise<Settings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings) {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** The recording in progress, kept so it survives an app restart or a stop from the notification. */
export type ActiveRecording = { id: string; path: string; startedAt: number };

export async function getActiveRecording(): Promise<ActiveRecording | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function setActiveRecording(rec: ActiveRecording | null) {
  if (rec) await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(rec));
  else await AsyncStorage.removeItem(ACTIVE_KEY);
}

export async function ensureDir(dir: string) {
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) await FS.makeDirectoryAsync(dir, { intermediates: true });
}

export function defaultTitle(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Встреча ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
