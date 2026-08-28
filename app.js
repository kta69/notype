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
 'clearHistory','selfUrl'].forEach(id => els[id] = $(id));

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

/* ---------------- 文字起こし ---------------- */

async function transcribe(blob) {
  const ext = (blob.type || '').includes('webm') ? 'webm' : 'm4a';
  const fd = new FormData();
  fd.append('file', blob, 'audio.' + ext);
  fd.append('model', ASR_MODEL);
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  if (S.language) fd.append('language', S.language);

  // 用語集を Whisper のプロンプトに渡すと、同音異義語がその語彙に引き寄せられる。
  const terms = S.vocabulary.trim();
  if (terms) fd.append('prompt', terms);

  const res = await fetch(`${GROQ}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${S.apiKey}` },
    body: fd,
  });

  if (!res.ok) throw new Error(await errorMessage(res));
  const json = await res.json();
  return clean(json.text || '');
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
  const pending = stopRecording();
  if (!pending) return;

  busy = true;
  els.micBtn.classList.add('busy');
  els.stage.hidden = false;
  els.stage.textContent = '文字起こし中…';

  // Safari は ClipboardItem に Promise を渡せるので、
  // このタップ（ユーザー操作）の権限のまま非同期の結果をコピーできる。
  let resolveText;
  const textPromise = new Promise(r => { resolveText = r; });
  const clipboardTried = S.autoCopy ? tryAsyncCopy(textPromise) : false;

  try {
    const blob = await pending;
    if (blob.size < 2000) {
      resolveText('');
      throw new Error('音声が短すぎます');
    }

    let text = await transcribe(blob);
    lastRaw = text;

    if (S.refineEnabled && text) {
      els.stage.textContent = 'AI で整形中…';
      try {
        text = await refine(text);
      } catch (e) {
        toast('整形をスキップしました: ' + e.message);
      }
    }

    resolveText(text);
    if (!text) throw new Error('何も聞き取れませんでした');

    show(text);
    remember(text);
    if (S.autoCopy && !clipboardTried) copy(text);
  } catch (e) {
    resolveText('');
    toast(e.message, true);
  } finally {
    busy = false;
    els.micBtn.classList.remove('busy');
    els.stage.hidden = true;
    els.timer.textContent = '0:00';
  }
}

function show(text) {
  els.resultText.textContent = text;
  els.resultCard.hidden = false;
  els.raw.hidden = !(S.refineEnabled && lastRaw && lastRaw !== text);
  els.raw.dataset.on = '';
  els.raw.textContent = '整形前を見る';
  els.copiedTag.hidden = true;
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  bindSettings();
  renderHistory();

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
    navigator.serviceWorker.register('sw.js?v=3').catch(() => {});
  }
}

init();
