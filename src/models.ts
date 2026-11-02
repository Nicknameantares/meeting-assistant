import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import { ModelFiles } from '../modules/meeting-recorder/src';

export type ModelKind = 'whisper' | 'llm';

export type ModelInfo = {
  id: string;
  kind: ModelKind;
  name: string;
  description: string;
  fileName: string;
  url: string;
  sizeMb: number;
  /** Phones with less RAM than this are warned that the model may not run. */
  minRamGb?: number;
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
    minRamGb: 6,
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
  {
    id: 'gigachat3.1-10b',
    kind: 'llm',
    name: 'GigaChat 3.1 Lightning',
    description: 'Модель Сбера, сильная в русском, отвечает быстро. Нужен телефон с 12 ГБ ОЗУ.',
    fileName: 'GigaChat3.1-10B-A1.8B-q4_K_M.gguf',
    url: `${HF}/ai-sage/GigaChat3.1-10B-A1.8B-GGUF/resolve/main/GigaChat3.1-10B-A1.8B-q4_K_M.gguf`,
    sizeMb: 6470,
    minRamGb: 11,
  },
];

const MODELS_DIR = ModelFiles.getModelsDir() + '/';
// Before build 5 models were stored in the app's private documents folder.
const LEGACY_DIR = `${FS.documentDirectory}models/`;
const DOWNLOADS_KEY = 'modelDownloads.v1';

export function getModel(id: string) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Неизвестная модель: ${id}`);
  return m;
}

const isComplete = (m: ModelInfo, size: number) => size > m.sizeMb * 1024 * 1024 * 0.9;

/** Path of the installed model file, or null when it is not installed. */
export async function resolveModelPath(m: ModelInfo): Promise<string | null> {
  const path = MODELS_DIR + m.fileName;
  if (isComplete(m, ModelFiles.fileSize(path))) return path;
  const legacy = await FS.getInfoAsync(LEGACY_DIR + m.fileName);
  if (legacy.exists && !legacy.isDirectory && isComplete(m, legacy.size ?? 0)) return LEGACY_DIR + m.fileName;
  return null;
}

export async function isModelReady(m: ModelInfo) {
  return (await resolveModelPath(m)) !== null;
}

export function totalRamGb() {
  return ModelFiles.getTotalRamBytes() / 1024 ** 3;
}

async function getDownloadIds(): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(DOWNLOADS_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function setDownloadId(modelId: string, id: string | null) {
  const ids = await getDownloadIds();
  if (id) ids[modelId] = id;
  else delete ids[modelId];
  await AsyncStorage.setItem(DOWNLOADS_KEY, JSON.stringify(ids));
}

/** Models whose download is still in progress, e.g. after the app was closed. */
export async function pendingDownloads(): Promise<string[]> {
  return Object.keys(await getDownloadIds());
}

export type DownloadProgress = { fraction: number; waiting: boolean };

/**
 * One-time download through the Android DownloadManager: it resumes after network drops
 * and continues with the app in the background. After that everything works offline.
 */
export async function downloadModel(m: ModelInfo, onProgress: (p: DownloadProgress) => void) {
  let id = (await getDownloadIds())[m.id];
  if (!id) {
    const needed = m.sizeMb * 1024 * 1024 * 1.05;
    const free = ModelFiles.getFreeBytes();
    if (free < needed) {
      throw new Error(
        `Не хватает памяти: нужно ${(needed / 1024 ** 3).toFixed(1)} ГБ, свободно ${(free / 1024 ** 3).toFixed(1)} ГБ.`,
      );
    }
    id = ModelFiles.startDownload(m.url, m.fileName, m.name);
    await setDownloadId(m.id, id);
  }

  for (;;) {
    const st = ModelFiles.getDownload(id, m.fileName);
    if (st.status === 'done') break;
    if (st.status === 'failed' || st.status === 'missing') {
      // Cancelled by the user: the id was already forgotten.
      if ((await getDownloadIds())[m.id] !== id) return false;
      await setDownloadId(m.id, null);
      ModelFiles.cancelDownload(id, m.fileName);
      throw new Error(downloadError(st.reason));
    }
    const total = st.total && st.total > 0 ? st.total : m.sizeMb * 1024 * 1024;
    onProgress({ fraction: (st.bytes ?? 0) / total, waiting: st.status === 'paused' || st.status === 'pending' });
    await new Promise((r) => setTimeout(r, 1000));
  }
  await setDownloadId(m.id, null);
  if (!(await isModelReady(m))) throw new Error('Файл модели скачался не полностью. Попробуйте ещё раз.');
  return true;
}

function downloadError(reason?: number) {
  switch (reason) {
    case 1006: // ERROR_INSUFFICIENT_SPACE
      return 'Не хватает памяти на телефоне.';
    case 1001: // ERROR_FILE_ERROR
      return 'Ошибка записи файла. Проверьте свободное место.';
    default:
      return `Загрузка не удалась (код ${reason ?? '—'}). Нажмите «Скачать» ещё раз или используйте «Из файла».`;
  }
}

export async function cancelDownload(m: ModelInfo) {
  const id = (await getDownloadIds())[m.id];
  if (id) ModelFiles.cancelDownload(id, m.fileName);
  await setDownloadId(m.id, null);
}

/** Offline alternative: pick a model file copied to the phone from a computer. */
export async function importModel(m: ModelInfo) {
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, type: '*/*' });
  if (res.canceled || !res.assets?.[0]) return false;
  await ModelFiles.importFromUri(res.assets[0].uri, m.fileName);
  return true;
}

export async function deleteModel(m: ModelInfo) {
  ModelFiles.deleteFile(MODELS_DIR + m.fileName);
  await FS.deleteAsync(LEGACY_DIR + m.fileName, { idempotent: true });
}
