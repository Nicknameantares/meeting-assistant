import { initLlama } from 'llama.rn';
import { initWhisper } from 'whisper.rn';
import { ModelInfo, modelPath } from './models';

/** Speech to text on the phone with whisper.cpp. The audio is a 16 kHz mono WAV. */
export async function transcribe(
  audioPath: string,
  model: ModelInfo,
  language: 'ru' | 'auto',
  onProgress: (percent: number) => void,
): Promise<string> {
  const ctx = await initWhisper({ filePath: modelPath(model) });
  try {
    const { promise } = ctx.transcribe(audioPath, {
      language,
      maxThreads: 4,
      onProgress,
    });
    const res = await promise;
    const text = res.segments.length
      ? res.segments.map((s) => s.text.trim()).filter(Boolean).join('\n')
      : res.result.trim();
    if (!text) throw new Error('В записи не распознано речи');
    return text;
  } finally {
    await ctx.release();
  }
}

const SYSTEM =
  'Ты ассистент, который помогает по итогам рабочих встреч. Отвечай только на русском языке, ' +
  'опирайся только на текст расшифровки и ничего не выдумывай. Расшифровка сделана автоматически ' +
  'и может содержать ошибки распознавания.';

const FINAL_PROMPT = `Составь итог встречи в таком формате:

## Кратко
2–4 предложения: о чём была встреча и к чему пришли.

## Ключевые моменты
- главные темы и аргументы

## Решения
- что решили (если ничего не решили, так и напиши)

## Задачи
- [ ] что сделать — ответственный (если назван) — срок (если назван)

## Открытые вопросы
- что осталось нерешённым или требует уточнения`;

// About 3 characters per token for Russian text: chunks stay well inside the context window.
const CHUNK_CHARS = 9000;
const N_CTX = 8192;

function splitText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length > size && current) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Summary with a local LLM. Long meetings are summarised in parts first
 * and the notes are then merged into one final summary.
 */
export async function summarize(
  transcript: string,
  model: ModelInfo,
  onProgress: (label: string) => void,
): Promise<string> {
  onProgress('Загрузка модели…');
  const ctx = await initLlama({
    model: modelPath(model),
    n_ctx: N_CTX,
    n_threads: 4,
    n_gpu_layers: 0,
    use_mlock: false,
  });

  const ask = async (user: string, maxTokens: number) => {
    const res = await ctx.completion({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      n_predict: maxTokens,
      temperature: 0.3,
      top_p: 0.9,
      enable_thinking: false,
    });
    return (res.content || res.text).trim();
  };

  try {
    const chunks = splitText(transcript, CHUNK_CHARS);
    if (chunks.length === 1) {
      onProgress('Составляю резюме…');
      return await ask(`Расшифровка встречи:\n\n${transcript}\n\n${FINAL_PROMPT}`, 1200);
    }

    const notes: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress(`Разбираю часть ${i + 1} из ${chunks.length}…`);
      notes.push(
        await ask(
          `Фрагмент ${i + 1} из ${chunks.length} расшифровки встречи:\n\n${chunks[i]}\n\n` +
            'Выпиши кратким списком: обсуждённые темы, принятые решения, задачи (кто, что, срок) и открытые вопросы. ' +
            'Сохрани имена, цифры и даты.',
          600,
        ),
      );
    }

    onProgress('Собираю итоговое резюме…');
    // If the notes themselves are too long, keep compressing them pairwise.
    let merged = notes;
    while (merged.join('\n').length > CHUNK_CHARS && merged.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < merged.length; i += 2) {
        const pair = merged.slice(i, i + 2).join('\n\n');
        next.push(
          merged.length - i === 1
            ? pair
            : await ask(`Объедини заметки по встрече, убрав повторы:\n\n${pair}`, 700),
        );
      }
      merged = next;
    }
    const all = merged.map((n, i) => `### Заметки ${i + 1}\n${n}`).join('\n\n');
    return await ask(`Заметки по частям одной встречи:\n\n${all}\n\n${FINAL_PROMPT}`, 1200);
  } finally {
    await ctx.release();
  }
}
