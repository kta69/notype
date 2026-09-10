/* NoType — 高精度音声入力 PWA
   録音 → Groq Whisper large-v3-turbo で文字起こし → 任意で AI 整形 → クリップボード */

'use strict';

const KEY = 'notype_v1';
const GROQ = 'https://api.groq.com/openai/v1';
const ASR_MODEL = 'whisper-large-v3-turbo';

const DEFAULTS = {
  apiKey: '',
  language: 'ja',
  vocabulary: '',
  refineEnabled: true,
  removeFillers: true,
  refineModel: 'openai/gpt-oss-120b',
  autoCopy: true,
  history: [],
  last: null,
  // 録音中に見ながら喋るための項目。日記用の初期値。
  prompts: [
    '昨日良かったことは？',
    '昨日できたことは？',
    '昨日感謝できたことは？',
    '昨日感じた自分の素直な気持ちは？特にモヤモヤ',
    'それがあったからこそこれからどうしていく？',
  ],
  promptsOpen: true,
};

let S = load();

function load() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(S));
}

const $ = (id) => document.getElementById(id);
const els = {};
['micBtn','micHint','meter','timer','stage','resultCard','resultText','copyBtn','copiedTag','raw','shareBtn',
 'historySec','history','settings','settingsBtn','closeSettings','toast','apiKey','language',
 'vocabulary','refineEnabled','removeFillers','refineModel','fetchModels','modelList','autoCopy',
 'clearHistory','selfUrl','exportBtn','importBtn','importFile',
 'pendingCard','pendingList',
 'promptCard','promptToggle','promptChev','promptEdit','promptBody','promptList','promptAdd']
  .forEach(id => els[id] = $(id));

const bars = [...document.querySelectorAll('.bars i')];

/* ---------------- 録音 ---------------- */

let media = null;      // MediaStream
let recorder = null;   // MediaRecorder
let chunks = [];
let audioCtx = null, analyser = null, meterRAF = 0;
let startedAt = 0, timerId = 0;
let wakeLock = null;
let recording = false, busy = false;
let lastRaw = '';

function pickMimeType() {
  // Safari は audio/mp4 (AAC)。Chrome 系は webm。どちらも Groq が受け付ける。
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startRecording(auto) {
  if (recording || busy) return;

  if (!S.apiKey) {
    toast('先に設定で Groq API キーを入れてください', true);
    openSettings();
    return;
  }

  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    if (auto) els.micHint.textContent = 'マイクをタップして録音開始';
    else toast('マイクを使えません: ' + e.name, true);
    return;
  }

  const mimeType = pickMimeType();
  try {
    recorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
  } catch {
    recorder = new MediaRecorder(media);
  }

  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start();

  recording = true;
  startedAt = Date.now();
  setRecUI(true);
  startMeter();
  timerId = setInterval(tick, 200);
  tick();

  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* 非対応でも問題ない */ }
}

function stopRecording() {
  if (!recording || !recorder) return null;
  recording = false;

  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' }));
  });
  recorder.stop();

  clearInterval(timerId);
  stopMeter();
  media.getTracks().forEach(t => t.stop());
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setRecUI(false);

  return done;
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  els.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setRecUI(on) {
  els.micBtn.classList.toggle('rec', on);
  els.meter.hidden = !on;
  els.micHint.textContent = on ? 'もう一度タップで停止' : 'タップして録音開始';
}

/* レベルメーター */

function startMeter() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(media);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      analyser.getByteFrequencyData(data);
      bars.forEach((bar, i) => {
        const v = data[Math.floor(i * data.length / bars.length)] / 255;
        bar.style.height = (4 + v * 30) + 'px';
        bar.style.opacity = 0.35 + v * 0.65;
      });
      meterRAF = requestAnimationFrame(draw);
    };
    draw();
  } catch { /* メーターは無くても動く */ }
}

function stopMeter() {
  cancelAnimationFrame(meterRAF);
  bars.forEach(b => { b.style.height = '4px'; b.style.opacity = 0.35; });
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
}

/* ---------------- 録音の保管 ----------------
   一度録った音は、文字起こしが失敗しても捨てない。
   localStorage は Blob を持てないので IndexedDB に置く。
   文字起こしが成功した時点で初めて消す。 */

const DB_NAME = 'notype';
const STORE = 'audio';
const KEEP_MAX = 10;

let pending = [];      // [{ at, blob }] 新しい順。未変換の録音。
let pendingUrls = [];

let dbPromise = null;
function openDB() {
  // 接続は開きっぱなしで使い回す。毎回開くと接続が溜まる。
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'at' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, run) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

/* 録音直後に呼ぶ。ここから先で何が失敗しても音は残る。 */
async function keepAudio(blob) {
  const item = { at: Date.now(), blob };
  pending.unshift(item);
  const overflow = pending.splice(KEEP_MAX);
  try {
    await tx('readwrite', s => {
      s.put(item);
      overflow.forEach(o => s.delete(o.at));
    });
  } catch { /* IndexedDB が使えなくても録音〜文字起こしは続行する */ }
  return item;
}

async function dropAudio(at) {
  pending = pending.filter(p => p.at !== at);
  renderPending();
  try {
    await tx('readwrite', s => s.delete(at));
  } catch { /* 消せなくても実害はない */ }
}

async function loadPending() {
  try {
    const all = await tx('readonly', s => s.getAll());
    pending = (all || []).sort((a, b) => b.at - a.at).slice(0, KEEP_MAX);
  } catch {
    pending = [];
  }
  renderPending();
}

function recTime(at) {
  const d = new Date(at);
  const m = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${m} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} の録音`;
}

function renderPending() {
  pendingUrls.forEach(URL.revokeObjectURL);
  pendingUrls = [];
  els.pendingList.innerHTML = '';
  els.pendingCard.hidden = pending.length === 0;

  for (const item of pending) {
    const url = URL.createObjectURL(item.blob);
    pendingUrls.push(url);

    const li = document.createElement('li');

    const when = document.createElement('span');
    when.className = 'pendAt';
    when.textContent = recTime(item.at);

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;

    const retry = document.createElement('button');
    retry.className = 'btn primary';
    retry.type = 'button';
    retry.textContent = 'もう一度文字起こし';
    retry.addEventListener('click', () => retryAudio(item));

    const del = document.createElement('button');
    del.className = 'btn ghost';
    del.type = 'button';
    del.textContent = '破棄';
    del.addEventListener('click', () => {
      if (confirm('この録音を消します。元に戻せません。')) dropAudio(item.at);
    });

    const row = document.createElement('div');
    row.className = 'row';
    row.append(retry, del);

    li.append(when, audio, row);
    els.pendingList.appendChild(li);
  }
}

function retryAudio(item) {
  if (busy) return;
  let resolveText;
  const textPromise = new Promise(r => { resolveText = r; });
  const clipboardTried = S.autoCopy ? tryAsyncCopy(textPromise) : false;
  transcribeAndShow(item, resolveText, clipboardTried);
}

/* ---------------- 文字起こし ---------------- */

/* Groq の prompt は 224 トークンまで。長すぎると無視されるか、
   そのまま出力に混ざる。安全側に切り詰める。 */
function promptTerms() {
  return S.vocabulary.trim().slice(0, 200);
}

async function transcribe(blob) {
  const ext = (blob.type || '').includes('webm') ? 'webm' : 'm4a';
  const fd = new FormData();
  fd.append('file', blob, 'audio.' + ext);
  fd.append('model', ASR_MODEL);
  // verbose_json にするとセグメントごとの信頼度が返る。幻聴の検出に必要。
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  if (S.language) fd.append('language', S.language);

  // 用語集を Whisper のプロンプトに渡すと、同音異義語がその語彙に引き寄せられる。
  const terms = promptTerms();
  if (terms) fd.append('prompt', terms);

  const res = await fetch(`${GROQ}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${S.apiKey}` },
    body: fd,
  });

  if (!res.ok) throw new Error(await errorMessage(res));
  const json = await res.json();

  return {
    text: clean(sanitize(json, terms)),
    heard: clean(json.text || ''),
  };
}

/* ---------------- 幻聴の除去 ----------------
   Whisper は無音・雑音区間で、実際には言っていない定型文を作る。
   verbose_json のセグメント統計と既知の定型文で機械的に落とす。 */

function norm(s) {
  return (s || '').replace(/[\s。、．，!！?？…・「」『』()（）\-‐―ー~〜]/g, '');
}

// 学習データ（字幕）由来で、無音時に湧いて出る定型文
const HALLUCINATIONS = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  '最後までご視聴いただきありがとうございました',
  'ご覧いただきありがとうございます',
  'チャンネル登録よろしくお願いします',
  'チャンネル登録お願いします',
  '高評価とチャンネル登録をお願いします',
  '字幕視聴ありがとうございました',
  'エンディング',
  'Thanksforwatching',
  'Thankyouforwatching',
  'SubtitlesbytheAmaraorgcommunity',
].map(norm);

function isHallucination(text) {
  const n = norm(text);
  return !n || HALLUCINATIONS.includes(n);
}

function usableSegment(seg) {
  const noSpeech = seg.no_speech_prob ?? 0;
  const logprob = seg.avg_logprob ?? 0;
  const ratio = seg.compression_ratio ?? 1.66;

  if (noSpeech > 0.6 && logprob < -1.0) return false; // 無音区間に文を作った
  if (ratio > 2.4) return false;                      // 同じ語のループ
  if (logprob < -1.4) return false;                   // 極端に自信がない
  if (isHallucination(seg.text)) return false;
  return true;
}

function sanitize(json, terms) {
  const segs = Array.isArray(json.segments) ? json.segments : null;
  let text;

  if (segs && segs.length) {
    const kept = [];
    let prev = '';
    for (const seg of segs) {
      if (!usableSegment(seg)) continue;
      const t = (seg.text || '').trim();
      if (!t || norm(t) === prev) continue; // 直前と同一の繰り返しを畳む
      prev = norm(t);
      kept.push(t);
    }
    text = kept.join('');
  } else {
    text = (json.text || '').trim();
  }

  if (isHallucination(text)) return '';

  // 用語集をそのまま吐き返してくることがある
  if (terms) {
    if (norm(text) === norm(terms)) return '';
    if (text.startsWith(terms)) text = text.slice(terms.length).trim();
  }
  return text;
}

/* 日本語の文字どうしに挟まった半角スペースを除去する */
function clean(text) {
  return text
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/(?<=[ぁ-んァ-ヶ一-龠、。「」])\s+(?=[ぁ-んァ-ヶ一-龠、。「」])/g, '');
}

/* ---------------- AI 整形 ---------------- */

async function refine(text) {
  const rules = [
    'あなたは日本語音声認識の後処理エンジンです。入力は音声認識の生テキストです。',
    '次の方針で修正し、修正後の本文だけを出力してください。説明・前置き・引用符は一切付けないこと。',
    '1. 同音異義語の誤変換を文脈から正しい漢字に直す。',
    '2. 句読点と改行を自然に補う。',
    '3. 話者の言い回しや語尾は変えない。要約や意訳は禁止。内容を足さない。',
    '4. 英数字・固有名詞の表記を正す。',
  ];
  if (S.removeFillers) {
    rules.push('5. 「えー」「あの」「まあ」などのフィラーと明らかな言い直しを削除する。');
  }
  const terms = S.vocabulary.trim();
  if (terms) {
    rules.push('以下は話者がよく使う固有名詞・専門用語です。該当しそうな箇所はこの表記に合わせること。');
    rules.push(terms);
  }

  const res = await fetch(`${GROQ}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${S.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: S.refineModel,
      temperature: 0,
      messages: [
        { role: 'system', content: rules.join('\n') },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) throw new Error(await errorMessage(res));
  const json = await res.json();
  const out = (json.choices?.[0]?.message?.content || '').trim();
  return out || text;
}

async function errorMessage(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.error?.message || '';
  } catch { /* 本文が JSON でないこともある */ }
  if (res.status === 401) return 'API キーが正しくありません';
  if (res.status === 429) return '無料枠の上限に達しました。少し待ってから試してください';
  return `${res.status} ${detail || res.statusText}`;
}

/* ---------------- パイプライン ---------------- */

async function finish() {
  const done = stopRecording();
  if (!done) return;

  busy = true;
  els.micBtn.classList.add('busy');
  els.stage.hidden = false;
  els.stage.textContent = '文字起こし中…';

  // Safari は ClipboardItem に Promise を渡せるので、
  // このタップ（ユーザー操作）の権限のまま非同期の結果をコピーできる。
  let resolveText;
  const textPromise = new Promise(r => { resolveText = r; });
  const clipboardTried = S.autoCopy ? tryAsyncCopy(textPromise) : false;

  const blob = await done;
  if (blob.size < 2000) {
    resolveText('');
    toast('音声が短すぎます', true);
    idle();
    return;
  }

  // 文字起こしより先に録音を保管する。以降どこで失敗しても録り直しは要らない。
  const item = await keepAudio(blob);
  await transcribeAndShow(item, resolveText, clipboardTried);
}

async function transcribeAndShow(item, resolveText, clipboardTried) {
  busy = true;
  els.micBtn.classList.add('busy');
  els.stage.hidden = false;
  els.stage.textContent = '文字起こし中…';

  try {
    const result = await transcribe(item.blob);
    lastRaw = result.heard;
    let text = result.text;

    if (S.refineEnabled && text) {
      els.stage.textContent = 'AI で整形中…';
      try {
        text = await refine(text);
      } catch (e) {
        toast('整形をスキップしました: ' + e.message);
      }
    }

    resolveText(text);
    if (!text) throw new Error('うまく聞き取れませんでした。録音は下に残してあります');

    // 保存を先に済ませる。描画で何が起きても記録だけは残す。
    remember(text);
    show(text);
    if (S.autoCopy && !clipboardTried) copy(text);

    // ここまで来て初めて録音を捨てる
    await dropAudio(item.at);
  } catch (e) {
    resolveText('');
    toast(e.message, true);
    renderPending();   // 録音は残っている。再試行できることを見せる。
  } finally {
    idle();
  }
}

function idle() {
  busy = false;
  els.micBtn.classList.remove('busy');
  els.stage.hidden = true;
  els.timer.textContent = '0:00';
}

function show(text, quiet) {
  els.resultText.textContent = text;
  els.resultCard.hidden = false;
  els.raw.hidden = !(S.refineEnabled && lastRaw && lastRaw !== text);
  els.raw.dataset.on = '';
  els.raw.textContent = '整形前を見る';
  els.copiedTag.hidden = true;

  // 画面に出したものは必ず保存する。放置してタブが再読み込みされても消えない。
  S.last = { text, heard: lastRaw };
  save();

  if (!quiet) els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- クリップボード ---------------- */

function tryAsyncCopy(promise) {
  if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
  try {
    const item = new ClipboardItem({
      'text/plain': promise.then(t => new Blob([t || ''], { type: 'text/plain' })),
    });
    navigator.clipboard.write([item])
      .then(() => { els.copiedTag.hidden = false; })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    els.copiedTag.hidden = false;
    toast('コピーしました');
  } catch {
    toast('コピーできませんでした。長押しで選択してください', true);
  }
}

/* ---------------- 話す項目 ----------------
   録音しながら見るためのメモ。日記の問いを並べておく。 */

let promptEditing = false;

function renderPrompts() {
  els.promptList.innerHTML = '';
  const sizers = [];

  S.prompts.forEach((text, i) => {
    const li = document.createElement('li');

    if (promptEditing) {
      li.className = 'edit';

      const ta = document.createElement('textarea');
      ta.rows = 1;
      ta.value = text;
      // scrollHeight は枠線を含まないので、border-box の分を足し戻す
      const grow = () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + (ta.offsetHeight - ta.clientHeight) + 'px';
      };
      ta.addEventListener('input', () => { S.prompts[i] = ta.value; save(); grow(); });
      sizers.push(grow);

      const del = document.createElement('button');
      del.className = 'hDel';
      del.type = 'button';
      del.setAttribute('aria-label', 'この項目を削除');
      del.textContent = '×';
      del.addEventListener('click', () => {
        S.prompts.splice(i, 1);
        save();
        renderPrompts();
      });

      li.append(ta, del);
    } else {
      li.textContent = text;
    }

    els.promptList.appendChild(li);
  });

  if (!promptEditing && S.prompts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'promptEmpty';
    empty.textContent = '「編集」から項目を追加できます。';
    els.promptList.appendChild(empty);
  }

  els.promptAdd.hidden = !promptEditing;
  els.promptEdit.textContent = promptEditing ? '完了' : '編集';
  els.promptBody.hidden = !S.promptsOpen;
  els.promptChev.classList.toggle('up', S.promptsOpen);

  // 高さ合わせは DOM に入れて表示状態を決めた後でないと測れない
  sizers.forEach(grow => grow());
}

function bindPrompts() {
  els.promptToggle.addEventListener('click', () => {
    S.promptsOpen = !S.promptsOpen;
    save();
    renderPrompts();
  });

  els.promptEdit.addEventListener('click', () => {
    promptEditing = !promptEditing;
    if (promptEditing) {
      S.promptsOpen = true;
    } else {
      // 空のまま残った項目は捨てる
      S.prompts = S.prompts.map(p => p.trim()).filter(Boolean);
    }
    save();
    renderPrompts();
  });

  els.promptAdd.addEventListener('click', () => {
    S.prompts.push('');
    save();
    renderPrompts();
    els.promptList.querySelector('li:last-child textarea')?.focus();
  });
}

/* ---------------- 履歴 ---------------- */

function remember(text) {
  S.history.unshift({ text, at: Date.now() });
  S.history = S.history.slice(0, 30);
  save();
  renderHistory();
}

function renderHistory() {
  els.historySec.hidden = S.history.length === 0;
  els.history.innerHTML = '';
  S.history.forEach((h, i) => {
    const li = document.createElement('li');

    const text = document.createElement('span');
    text.className = 'hText';
    text.textContent = h.text;
    text.addEventListener('click', () => {
      lastRaw = '';
      show(h.text);
      copy(h.text);
    });

    const del = document.createElement('button');
    del.className = 'hDel';
    del.type = 'button';
    del.setAttribute('aria-label', 'この履歴を削除');
    del.textContent = '×';
    del.addEventListener('click', () => {
      S.history.splice(i, 1);
      save();
      renderHistory();
    });

    li.append(text, del);
    els.history.appendChild(li);
  });
}

/* ---------------- 設定 ---------------- */

function openSettings() {
  els.apiKey.value = S.apiKey;
  els.language.value = S.language;
  els.vocabulary.value = S.vocabulary;
  els.refineEnabled.checked = S.refineEnabled;
  els.removeFillers.checked = S.removeFillers;
  els.refineModel.value = S.refineModel;
  els.autoCopy.checked = S.autoCopy;
  els.selfUrl.textContent = location.origin + location.pathname + '?rec=1';
  els.settings.hidden = false;
}

function bindSettings() {
  const sync = () => {
    S.apiKey = els.apiKey.value.trim();
    S.language = els.language.value;
    S.vocabulary = els.vocabulary.value;
    S.refineEnabled = els.refineEnabled.checked;
    S.removeFillers = els.removeFillers.checked;
    S.refineModel = els.refineModel.value.trim() || DEFAULTS.refineModel;
    S.autoCopy = els.autoCopy.checked;
    save();
  };
  ['apiKey','language','vocabulary','refineEnabled','removeFillers','refineModel','autoCopy']
    .forEach(id => els[id].addEventListener('change', sync));
  els.vocabulary.addEventListener('input', sync);
  els.apiKey.addEventListener('input', sync);

  els.settingsBtn.addEventListener('click', openSettings);
  els.closeSettings.addEventListener('click', () => { els.settings.hidden = true; });

  els.clearHistory.addEventListener('click', () => {
    S.history = [];
    save();
    renderHistory();
    toast('履歴を消去しました');
  });

  // iOS はサイトのデータを勝手に消すことがある。手元にファイルで逃がせるようにする。
  els.exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notype-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  els.importBtn.addEventListener('click', () => els.importFile.click());

  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files[0];
    els.importFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object') throw new Error();
      S = Object.assign({}, DEFAULTS, data);
      save();
      renderHistory();
      renderPrompts();
      openSettings();
      toast('読み込みました');
    } catch {
      toast('このファイルは読めませんでした', true);
    }
  });

  // モデル ID は時々変わるので、実際に使えるものを API から取ってくる
  els.fetchModels.addEventListener('click', async () => {
    if (!S.apiKey) { toast('先に API キーを入れてください', true); return; }
    try {
      const res = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${S.apiKey}` } });
      if (!res.ok) throw new Error(await errorMessage(res));
      const json = await res.json();
      const ids = json.data
        .map(m => m.id)
        .filter(id => !/whisper|tts|guard|prompt/i.test(id))
        .sort();
      els.modelList.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
      els.modelList.value = ids.includes(S.refineModel) ? S.refineModel : ids[0];
      els.modelList.hidden = false;
    } catch (e) {
      toast(e.message, true);
    }
  });

  els.modelList.addEventListener('change', () => {
    els.refineModel.value = els.modelList.value;
    S.refineModel = els.modelList.value;
    save();
  });
}

/* ---------------- toast ---------------- */

let toastId = 0;
function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.classList.toggle('err', !!isError);
  els.toast.hidden = false;
  clearTimeout(toastId);
  toastId = setTimeout(() => { els.toast.hidden = true; }, isError ? 4200 : 2000);
}

/* ---------------- 起動 ---------------- */

function init() {
  // ホーム画面アプリなら iOS の自動データ削除の対象外になる
  navigator.storage?.persist?.().catch(() => {});

  bindSettings();
  bindPrompts();
  renderPrompts();
  renderHistory();

  // 前回文字起こしできなかった録音を復元する
  loadPending();

  // 前回の結果を復元する（放置してタブが破棄されても残る）
  if (S.last?.text) {
    lastRaw = S.last.heard || '';
    show(S.last.text, true);
  }

  els.micBtn.addEventListener('click', () => {
    if (recording) finish();
    else startRecording();
  });

  els.copyBtn.addEventListener('click', () => copy(els.resultText.textContent));

  // 共有シート経由なら、テキストを受け取れるアプリ（日記など）へ直接渡せる
  els.shareBtn.hidden = !navigator.share;
  els.shareBtn.addEventListener('click', () => {
    navigator.share({ text: els.resultText.textContent }).catch(() => {});
  });

  els.raw.addEventListener('click', () => {
    const showingRaw = els.raw.dataset.on === '1';
    if (!showingRaw) els.raw.dataset.refined = els.resultText.textContent;
    els.raw.dataset.on = showingRaw ? '' : '1';
    els.raw.textContent = showingRaw ? '整形前を見る' : '整形後に戻る';
    els.resultText.textContent = showingRaw ? els.raw.dataset.refined : lastRaw;
  });

  // ショートカット（アクションボタン / 背面タップ）から ?rec=1 で開いたら即録音。
  // ブラウザがユーザー操作を要求して弾いた場合は、そのままボタン待ちにする。
  if (new URLSearchParams(location.search).get('rec') === '1') {
    startRecording(true);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=6').catch(() => {});
  }
}

init();
