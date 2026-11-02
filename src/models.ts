import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import { ensureDir } from './storage';

export type ModelKind = 'whisper' | 'llm';

export type ModelInfo = {
  id: string;
  kind: ModelKind;
  name: string;
  description: string;
  fileName: string;
  url: string;
  sizeMb: number;
};

const HF = 'https://huggingface.co';

export const MODELS: ModelInfo[] = [
  {
    id: 'whisper-base',
    kind: 'whisper',
    name: 'Whisper Base',
    description: 'Быстрая, но ошибается чаще. Для слабых телефонов.',
    fileName: 'ggml-base-q5_1.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin`,
    sizeMb: 60,
  },
  {
    id: 'whisper-small',
    kind: 'whisper',
    name: 'Whisper Small (рекомендуется)',
    description: 'Хороший баланс качества русского и скорости.',
    fileName: 'ggml-small-q5_1.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin`,
    sizeMb: 190,
  },
  {
    id: 'whisper-turbo',
    kind: 'whisper',
    name: 'Whisper Large v3 Turbo',
    description: 'Лучшее качество, но расшифровка в несколько раз дольше.',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`,
    sizeMb: 575,
  },
  {
    id: 'qwen3-4b',
    kind: 'llm',
    name: 'Qwen3 4B Instruct (рекомендуется)',
    description: 'Качественные резюме на русском. Нужно 6–8 ГБ ОЗУ.',
    fileName: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: `${HF}/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`,
    sizeMb: 2500,
  },
  {
    id: 'qwen25-1.5b',
    kind: 'llm',
    name: 'Qwen2.5 1.5B Instruct',
    description: 'Лёгкая и быстрая, резюме попроще. Для телефонов с 4 ГБ ОЗУ.',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: `${HF}/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf`,
    sizeMb: 1100,
  },
];

export const MODELS_DIR = `${FS.documentDirectory}models/`;

export function getModel(id: string) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Неизвестная модель: ${id}`);
  return m;
}

export function modelPath(m: ModelInfo) {
  return MODELS_DIR + m.fileName;
}

export async function isModelReady(m: ModelInfo) {
  const info = await FS.getInfoAsync(modelPath(m));
  // A finished file is at least half the expected size; this filters out broken downloads.
  return info.exists && !info.isDirectory && (info.size ?? 0) > m.sizeMb * 1024 * 1024 * 0.5;
}

/** One-time download; after that everything works offline. */
export async function downloadModel(m: ModelInfo, onProgress: (fraction: number) => void) {
  await ensureDir(MODELS_DIR);
  const tmp = modelPath(m) + '.part';
  const task = FS.createDownloadResumable(m.url, tmp, {}, (p) => {
    if (p.totalBytesExpectedToWrite > 0) onProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
  });
  const res = await task.downloadAsync();
  if (!res || res.status !== 200) {
    await FS.deleteAsync(tmp, { idempotent: true });
    throw new Error(`Не удалось скачать модель (код ${res?.status ?? '—'})`);
  }
  await FS.moveAsync({ from: tmp, to: modelPath(m) });
}

/** Offline alternative: pick a model file copied to the phone from a computer. */
export async function importModel(m: ModelInfo) {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, type: '*/*' });
  if (res.canceled || !res.assets?.[0]) return false;
  await ensureDir(MODELS_DIR);
  await FS.deleteAsync(modelPath(m), { idempotent: true });
  await FS.copyAsync({ from: res.assets[0].uri, to: modelPath(m) });
  return true;
}

export async function deleteModel(m: ModelInfo) {
  await FS.deleteAsync(modelPath(m), { idempotent: true });
}
