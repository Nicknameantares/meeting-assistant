import * as SecureStore from 'expo-secure-store';

/**
 * GigaChat API (Sber). Used for summaries when the phone is online,
 * so the large local model does not have to be downloaded.
 * Its certificates chain to the Russian Trusted Root CA, bundled at build time
 * (see plugins/withRussianTrustedCA.js).
 */
const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
const KEY_NAME = 'gigachatAuthKey';

export const GIGACHAT_MODELS = [
  { id: 'GigaChat-2-Lite', name: 'Lite', description: 'быстрее и дешевле' },
  { id: 'GigaChat-2-Pro', name: 'Pro', description: 'рекомендуется' },
  { id: 'GigaChat-2-Max', name: 'Max', description: 'лучшее качество' },
];

export async function getAuthKey() {
  return (await SecureStore.getItemAsync(KEY_NAME)) ?? '';
}

export async function setAuthKey(key: string) {
  if (key.trim()) await SecureStore.setItemAsync(KEY_NAME, key.trim());
  else await SecureStore.deleteItemAsync(KEY_NAME);
  token = null;
}

/** Thrown when the server cannot be reached, so the caller can fall back to the local model. */
export class OfflineError extends Error {}

let token: { value: string; expiresAt: number } | null = null;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function request(url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new OfflineError('Нет соединения с GigaChat');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('GigaChat не принял ключ авторизации. Проверьте его в настройках.');
    if (res.status === 402) throw new Error('В GigaChat закончились токены по вашему тарифу.');
    throw new Error(`GigaChat ответил ошибкой ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getToken() {
  if (token && token.expiresAt - Date.now() > 60_000) return token.value;
  const key = await getAuthKey();
  if (!key) throw new Error('Не задан ключ GigaChat');
  const data = await request(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${key}`,
      RqUID: uuid(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'scope=GIGACHAT_API_PERS',
  });
  token = { value: data.access_token, expiresAt: data.expires_at };
  return token.value;
}

export async function gigachatAsk(model: string, system: string, user: string, maxTokens: number) {
  const data = await request(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('GigaChat вернул пустой ответ');
  return String(text).trim();
}
