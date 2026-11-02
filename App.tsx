import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as FS from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  FlatList,
  Permission,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getRecorderStatus, startRecording, stopRecording } from './modules/meeting-recorder/src';
import { summarize, transcribe } from './src/ai';
import { MODELS, ModelInfo, deleteModel, downloadModel, getModel, importModel, isModelReady } from './src/models';
import {
  DEFAULT_SETTINGS,
  Meeting,
  RECORDINGS_DIR,
  Settings,
  defaultTitle,
  ensureDir,
  formatDuration,
  getActiveRecording,
  loadMeetings,
  loadSettings,
  saveMeetings,
  saveSettings,
  setActiveRecording,
} from './src/storage';

type Screen = { name: 'home' } | { name: 'meeting'; id: string } | { name: 'models' };

const STATUS_LABEL: Record<Meeting['status'], string> = {
  recorded: 'Записано, не обработано',
  transcribing: 'Расшифровка…',
  summarizing: 'Резюме…',
  done: 'Готово',
  error: 'Ошибка',
};

async function requestPermissions() {
  if (Platform.OS !== 'android') return true;
  const perms: Permission[] = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (Number(Platform.Version) >= 33) perms.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const res = await PermissionsAndroid.requestMultiple(perms);
  return res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === 'granted';
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const meetingsRef = useRef<Meeting[]>([]);
  const busy = useRef(false);

  const updateMeetings = useCallback(async (fn: (m: Meeting[]) => Meeting[]) => {
    const next = fn(meetingsRef.current);
    meetingsRef.current = next;
    setMeetings(next);
    await saveMeetings(next);
  }, []);

  const patchMeeting = useCallback(
    (id: string, patch: Partial<Meeting>) =>
      updateMeetings((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m))),
    [updateMeetings],
  );

  // A recording stopped from the notification (or before an app restart) is added to the list here.
  const syncRecorder = useCallback(async () => {
    const status = getRecorderStatus();
    const active = await getActiveRecording();
    setRecording(status.isRecording);
    if (!status.isRecording && active) {
      await setActiveRecording(null);
      const info = await FS.getInfoAsync(active.path);
      if (info.exists && !meetingsRef.current.some((m) => m.id === active.id)) {
        const durationMs = Math.max(0, ((info.size ?? 44) - 44) / 32);
        await updateMeetings((list) => [
          {
            id: active.id,
            title: defaultTitle(active.startedAt),
            createdAt: active.startedAt,
            durationMs,
            audioPath: active.path,
            status: 'recorded',
          },
          ...list,
        ]);
      }
    }
  }, [updateMeetings]);

  useEffect(() => {
    (async () => {
      const [list, s] = await Promise.all([loadMeetings(), loadSettings()]);
      // Processing interrupted by closing the app: let the user restart it.
      const fixed = list.map((m) =>
        m.status === 'transcribing' || m.status === 'summarizing'
          ? { ...m, status: 'error' as const, error: 'Обработка прервалась. Запустите заново.' }
          : m,
      );
      meetingsRef.current = fixed;
      setMeetings(fixed);
      setSettings(s);
      await syncRecorder();
    })();
    const sub = AppState.addEventListener('change', (st) => st === 'active' && syncRecorder());
    return () => sub.remove();
  }, [syncRecorder]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const st = getRecorderStatus();
      setElapsed(st.durationMs);
      setLevel(st.level);
      if (!st.isRecording) syncRecorder();
    }, 250);
    return () => clearInterval(t);
  }, [recording, syncRecorder]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'home') return false;
      setScreen({ name: 'home' });
      return true;
    });
    return () => sub.remove();
  }, [screen]);

  const process = useCallback(
    async (id: string) => {
      if (busy.current) {
        Alert.alert('Подождите', 'Сейчас обрабатывается другая встреча.');
        return;
      }
      const meeting = meetingsRef.current.find((m) => m.id === id);
      if (!meeting) return;
      const wModel = getModel(settings.whisperModelId);
      const lModel = getModel(settings.llmModelId);
      const missing = [];
      if (!meeting.transcript && !(await isModelReady(wModel))) missing.push(wModel.name);
      if (!(await isModelReady(lModel))) missing.push(lModel.name);
      if (missing.length) {
        Alert.alert('Нужны модели', `Скачайте или импортируйте: ${missing.join(', ')}`, [
          { text: 'Отмена', style: 'cancel' },
          { text: 'К моделям', onPress: () => setScreen({ name: 'models' }) },
        ]);
        return;
      }

      busy.current = true;
      await activateKeepAwakeAsync('processing');
      const setP = (label: string) => setProgress((p) => ({ ...p, [id]: label }));
      try {
        let transcript = meeting.transcript;
        if (!transcript) {
          await patchMeeting(id, { status: 'transcribing', error: undefined });
          setP('Расшифровка: 0%');
          transcript = await transcribe(meeting.audioPath, wModel, settings.language, (pct) =>
            setP(`Расшифровка: ${pct}%`),
          );
          await patchMeeting(id, { transcript });
        }
        await patchMeeting(id, { status: 'summarizing', error: undefined });
        const summary = await summarize(transcript, lModel, setP);
        await patchMeeting(id, { summary, status: 'done' });
      } catch (e: any) {
        await patchMeeting(id, { status: 'error', error: String(e?.message ?? e) });
      } finally {
        busy.current = false;
        deactivateKeepAwake('processing');
        setProgress((p) => {
          const { [id]: _, ...rest } = p;
          return rest;
        });
      }
    },
    [settings, patchMeeting],
  );

  const onRecordPress = async () => {
    if (recording) {
      setRecording(false);
      const active = await getActiveRecording();
      const res = await stopRecording();
      await setActiveRecording(null);
      if (!active) return;
      const meeting: Meeting = {
        id: active.id,
        title: defaultTitle(active.startedAt),
        createdAt: active.startedAt,
        durationMs: res.durationMs,
        audioPath: active.path,
        status: 'recorded',
      };
      await updateMeetings((list) => (list.some((x) => x.id === meeting.id) ? list : [meeting, ...list]));
      process(meeting.id);
      return;
    }
    if (!(await requestPermissions())) {
      Alert.alert('Нет доступа к микрофону', 'Разрешите запись звука в настройках телефона.');
      return;
    }
    await ensureDir(RECORDINGS_DIR);
    const id = String(Date.now());
    const path = `${RECORDINGS_DIR}${id}.wav`;
    await setActiveRecording({ id, path, startedAt: Date.now() });
    startRecording(path);
    setElapsed(0);
    setRecording(true);
  };

  const deleteMeeting = (m: Meeting) =>
    Alert.alert('Удалить встречу?', m.title, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          await FS.deleteAsync(m.audioPath, { idempotent: true });
          await updateMeetings((list) => list.filter((x) => x.id !== m.id));
          setScreen({ name: 'home' });
        },
      },
    ]);

  const changeSettings = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  };

  let content;
  if (screen.name === 'meeting') {
    const m = meetings.find((x) => x.id === screen.id);
    content = m ? (
      <MeetingScreen
        meeting={m}
        progress={progress[m.id]}
        onBack={() => setScreen({ name: 'home' })}
        onRename={(title) => patchMeeting(m.id, { title })}
        onProcess={() => process(m.id)}
        onResummarize={async () => {
          await patchMeeting(m.id, { summary: undefined });
          process(m.id);
        }}
        onEditSummary={(summary) => patchMeeting(m.id, { summary })}
        onDelete={() => deleteMeeting(m)}
      />
    ) : null;
  } else if (screen.name === 'models') {
    content = (
      <ModelsScreen settings={settings} onChange={changeSettings} onBack={() => setScreen({ name: 'home' })} />
    );
  } else {
    content = (
      <View style={{ flex: 1 }}>
        <View style={styles.header}>
          <Text style={styles.title}>Ассистент встреч</Text>
          <Pressable onPress={() => setScreen({ name: 'models' })} hitSlop={12}>
            <Text style={styles.link}>Модели</Text>
          </Pressable>
        </View>

        <View style={styles.recordBox}>
          <Pressable
            onPress={onRecordPress}
            style={[styles.recordBtn, recording && styles.recordBtnActive]}
          >
            <View style={recording ? styles.stopIcon : styles.recIcon} />
          </Pressable>
          <Text style={styles.recordText}>
            {recording ? `Запись ${formatDuration(elapsed)}` : 'Нажмите, чтобы начать запись'}
          </Text>
          {recording && (
            <>
              <View style={styles.levelTrack}>
                <View style={[styles.levelBar, { width: `${Math.min(100, level * 400)}%` }]} />
              </View>
              <Text style={styles.hint}>Можно заблокировать экран: запись продолжится.</Text>
            </>
          )}
        </View>

        <FlatList
          data={meetings}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          ListEmptyComponent={<Text style={styles.empty}>Записей пока нет</Text>}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => setScreen({ name: 'meeting', id: item.id })}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardMeta}>
                {formatDuration(item.durationMs)} · {progress[item.id] ?? STATUS_LABEL[item.status]}
              </Text>
            </Pressable>
          )}
        />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {content}
    </SafeAreaView>
  );
}

function MeetingScreen(props: {
  meeting: Meeting;
  progress?: string;
  onBack: () => void;
  onRename: (t: string) => void;
  onProcess: () => void;
  onResummarize: () => void;
  onEditSummary: (summary: string) => void;
  onDelete: () => void;
}) {
  const { meeting: m, progress } = props;
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary');
  const [title, setTitle] = useState(m.title);
  const working = m.status === 'transcribing' || m.status === 'summarizing';

  const share = () => {
    const body = tab === 'summary' ? m.summary : m.transcript;
    if (body) Share.share({ title: m.title, message: `${m.title}\n\n${body}` });
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack} hitSlop={12}>
          <Text style={styles.link}>‹ Назад</Text>
        </Pressable>
        <Pressable onPress={props.onDelete} hitSlop={12}>
          <Text style={[styles.link, { color: '#c0392b' }]}>Удалить</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.titleInput}
        value={title}
        onChangeText={setTitle}
        onEndEditing={() => title.trim() && props.onRename(title.trim())}
      />
      <Text style={styles.meta}>
        {formatDuration(m.durationMs)} · {progress ?? STATUS_LABEL[m.status]}
      </Text>
      {m.error && <Text style={styles.error}>{m.error}</Text>}

      {!working && m.status !== 'done' && (
        <Pressable style={styles.primaryBtn} onPress={props.onProcess}>
          <Text style={styles.primaryBtnText}>Расшифровать и сделать резюме</Text>
        </Pressable>
      )}
      {working && <Text style={styles.hint}>Не закрывайте приложение до окончания обработки.</Text>}

      <View style={styles.tabs}>
        {(['summary', 'transcript'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'summary' ? 'Резюме' : 'Расшифровка'}
            </Text>
          </Pressable>
        ))}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {tab === 'summary' && m.summary ? (
          <SummaryView text={m.summary} onChange={props.onEditSummary} />
        ) : (
          <Text selectable style={styles.body}>
            {(tab === 'summary' ? m.summary : m.transcript) ?? 'Пока пусто.'}
          </Text>
        )}
      </ScrollView>
      <View style={styles.bottomRow}>
        <Pressable style={styles.secondaryBtn} onPress={share}>
          <Text style={styles.secondaryBtnText}>Поделиться</Text>
        </Pressable>
        {m.status === 'done' && (
          <Pressable style={styles.secondaryBtn} onPress={props.onResummarize}>
            <Text style={styles.secondaryBtnText}>Новое резюме</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Renders the model's Markdown-like summary: headings, bullets and tappable task checkboxes. */
function SummaryView({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const lines = text.split('\n');
  const inline = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

  const toggle = (i: number) => {
    const next = [...lines];
    next[i] = /\[ \]/.test(next[i]) ? next[i].replace('[ ]', '[x]') : next[i].replace(/\[[xX]\]/, '[ ]');
    onChange(next.join('\n'));
  };

  return (
    <View>
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
          return (
            <Text key={i} style={[styles.mdHeading, i === 0 && { marginTop: 0 }]}>
              {inline(heading[1])}
            </Text>
          );
        }
        const task = line.match(/^[-*]\s+\[( |x|X)\]\s*(.*)$/);
        if (task) {
          const done = task[1] !== ' ';
          return (
            <Pressable key={i} style={styles.mdRow} onPress={() => toggle(i)} hitSlop={4}>
              <View style={[styles.checkbox, done && styles.checkboxDone]}>
                {done && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={[styles.mdText, done && styles.mdDone]}>{inline(task[2])}</Text>
            </Pressable>
          );
        }
        const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
        if (bullet) {
          return (
            <View key={i} style={styles.mdRow}>
              <Text style={styles.mdBullet}>•</Text>
              <Text selectable style={styles.mdText}>{inline(bullet[1])}</Text>
            </View>
          );
        }
        return (
          <Text key={i} selectable style={[styles.body, { marginBottom: 6 }]}>
            {inline(line)}
          </Text>
        );
      })}
    </View>
  );
}

function ModelsScreen(props: { settings: Settings; onChange: (p: Partial<Settings>) => void; onBack: () => void }) {
  const { settings } = props;
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    const entries = await Promise.all(MODELS.map(async (m) => [m.id, await isModelReady(m)] as const));
    setReady(Object.fromEntries(entries));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const download = async (m: ModelInfo) => {
    setLoading((l) => ({ ...l, [m.id]: 0 }));
    await activateKeepAwakeAsync('download');
    try {
      await downloadModel(m, (f) => setLoading((l) => ({ ...l, [m.id]: f })));
    } catch (e: any) {
      Alert.alert('Ошибка загрузки', String(e?.message ?? e));
    } finally {
      deactivateKeepAwake('download');
      setLoading(({ [m.id]: _, ...rest }) => rest);
      refresh();
    }
  };

  const importFile = async (m: ModelInfo) => {
    setLoading((l) => ({ ...l, [m.id]: -1 }));
    try {
      await importModel(m);
    } catch (e: any) {
      Alert.alert('Ошибка импорта', String(e?.message ?? e));
    } finally {
      setLoading(({ [m.id]: _, ...rest }) => rest);
      refresh();
    }
  };

  const section = (kind: ModelInfo['kind'], label: string, key: 'whisperModelId' | 'llmModelId') => (
    <View style={{ marginBottom: 24 }}>
      <Text style={styles.section}>{label}</Text>
      {MODELS.filter((m) => m.kind === kind).map((m) => {
        const selected = settings[key] === m.id;
        const l = loading[m.id];
        return (
          <Pressable
            key={m.id}
            style={[styles.card, selected && styles.cardSelected]}
            onPress={() => props.onChange({ [key]: m.id })}
          >
            <Text style={styles.cardTitle}>
              {selected ? '● ' : '○ '}
              {m.name}
            </Text>
            <Text style={styles.cardMeta}>
              {m.description} ~{m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} ГБ` : `${m.sizeMb} МБ`}
            </Text>
            <View style={styles.row}>
              {l !== undefined ? (
                <Text style={styles.cardMeta}>{l < 0 ? 'Копирование…' : `Загрузка ${Math.round(l * 100)}%`}</Text>
              ) : ready[m.id] ? (
                <>
                  <Text style={[styles.cardMeta, { color: '#27ae60' }]}>Установлена</Text>
                  <Pressable onPress={async () => { await deleteModel(m); refresh(); }} hitSlop={8}>
                    <Text style={[styles.link, { color: '#c0392b' }]}>Удалить</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable onPress={() => download(m)} hitSlop={8}>
                    <Text style={styles.link}>Скачать</Text>
                  </Pressable>
                  <Pressable onPress={() => importFile(m)} hitSlop={8}>
                    <Text style={styles.link}>Из файла</Text>
                  </Pressable>
                </>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack} hitSlop={12}>
          <Text style={styles.link}>‹ Назад</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.hint}>
          Модели скачиваются один раз (лучше по Wi‑Fi). После этого запись, расшифровка и резюме работают без
          интернета. Можно также скопировать файл модели с компьютера и выбрать его через «Из файла».
        </Text>
        {section('whisper', 'Расшифровка речи', 'whisperModelId')}
        {section('llm', 'Резюме', 'llmModelId')}
        <Text style={styles.section}>Язык встреч</Text>
        <View style={styles.row}>
          {(['ru', 'auto'] as const).map((lang) => (
            <Pressable
              key={lang}
              onPress={() => props.onChange({ language: lang })}
              style={[styles.tab, settings.language === lang && styles.tabActive]}
            >
              <Text style={[styles.tabText, settings.language === lang && styles.tabTextActive]}>
                {lang === 'ru' ? 'Русский' : 'Определять автоматически'}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f7f9', paddingTop: Platform.OS === 'android' ? 32 : 0 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111' },
  link: { fontSize: 16, color: '#2563eb', fontWeight: '600' },
  recordBox: { alignItems: 'center', paddingVertical: 24 },
  recordBtn: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#fff',
    borderWidth: 4,
    borderColor: '#e11d48',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  recordBtnActive: { backgroundColor: '#ffe4e6' },
  recIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#e11d48' },
  stopIcon: { width: 44, height: 44, borderRadius: 6, backgroundColor: '#e11d48' },
  recordText: { marginTop: 16, fontSize: 18, color: '#111', fontVariant: ['tabular-nums'] },
  levelTrack: { marginTop: 12, width: 200, height: 6, borderRadius: 3, backgroundColor: '#e5e7eb', overflow: 'hidden' },
  levelBar: { height: 6, backgroundColor: '#e11d48' },
  hint: { marginTop: 8, marginHorizontal: 16, marginBottom: 12, color: '#6b7280', fontSize: 14, textAlign: 'center' },
  empty: { textAlign: 'center', color: '#9ca3af', marginTop: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#eee' },
  cardSelected: { borderColor: '#2563eb' },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#111' },
  cardMeta: { marginTop: 4, fontSize: 14, color: '#6b7280' },
  row: { flexDirection: 'row', gap: 20, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' },
  section: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', marginBottom: 8 },
  titleInput: { fontSize: 22, fontWeight: '700', color: '#111', marginHorizontal: 16, paddingVertical: 4 },
  meta: { marginHorizontal: 16, color: '#6b7280', fontSize: 14 },
  error: { marginHorizontal: 16, marginTop: 8, color: '#c0392b' },
  primaryBtn: { margin: 16, backgroundColor: '#2563eb', borderRadius: 12, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 12 },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#e5e7eb' },
  tabActive: { backgroundColor: '#111' },
  tabText: { color: '#111', fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  body: { fontSize: 16, lineHeight: 24, color: '#111' },
  bottomRow: { flexDirection: 'row', gap: 10, padding: 16 },
  mdHeading: { fontSize: 18, fontWeight: '700', color: '#111', marginTop: 18, marginBottom: 8 },
  mdRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  mdBullet: { fontSize: 16, lineHeight: 24, color: '#6b7280', width: 12 },
  mdText: { flex: 1, fontSize: 16, lineHeight: 24, color: '#111' },
  mdDone: { color: '#9ca3af', textDecorationLine: 'line-through' },
  checkbox: {
    width: 22,
    height: 22,
    marginTop: 1,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: '#2563eb' },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 16 },
  secondaryBtn: { flex: 1, borderRadius: 12, padding: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: '#ddd' },
  secondaryBtnText: { color: '#111', fontWeight: '600' },
});
