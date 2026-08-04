/**
 * conversation.js
 * Conversation Practice — OpenAI Realtime API + push-to-talk
 *
 * LEFT panel shows ONLY:
 *   - Your spoken words (student transcript only — NO tutor text)
 *   - Tutor avatar animates + dots while model audio plays
 *   - A single "Hold to Speak" button
 *
 * RIGHT panel shows:
 *   - Correction entries (matching Python _display_correction_panel)
 */

/* ─── Config ──────────────────────────────────── */
// API key is fetched at runtime from the user's browser (localStorage).
// See js/api-key.js — never hardcode a key here.
const OPENAI_API_KEY = window.getApiKey ? window.getApiKey() : '';
const REALTIME_URL     = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const CORRECTION_MODEL = "gpt-4o";
const EVALUATION_MODEL = "gpt-4o";
const MAX_REPEAT       = 2;
const OUT_SR           = 24000;
const FALLBACK_MS      = 20000;

/* ─── Chapter context (loaded from ?chapter=ID) ──── */
const CHAPTER_ID = new URLSearchParams(location.search).get('chapter') || null;
let chapterCtx = null;   // { title, description, custom_prompt, materials, contextBlock }

/* ─── Prompts ─────────────────────────────────── */
const SYSTEM_PROMPT = `You are a French language professor named Professeur Dominique. Your primary role is to help an A1-level student improve their spoken French — especially pronunciation and grammar — through interactive oral practice.

**Tone & Style:**
- Speak ONLY in simple French during normal conversation.
- Use a warm, encouraging, but precise teaching tone.
- Keep your spoken turns SHORT: 1–3 sentences maximum.

**Normal conversation flow:**
1. Open the session: "Bonjour ! Je m'appelle le professeur Dominique. Comment tu t'appelles ?"
2. Engage in natural, everyday-topic conversation — ask simple follow-up questions.
3. After each student turn, check for any pronunciation or grammar issues you detect
   yourself, and model the correct forms naturally in your reply.

**Handling [CORRECTION REQUIRED] instructions:**
When you see a message that starts with [CORRECTION REQUIRED], the correction
system has detected specific errors in the student's last utterance. In that case:
  a) Immediately say the corrected version clearly and slightly slowly in French,
     e.g. "On dit : '<corrected sentence>'. Écoute bien."
  b) Ask the student to repeat: "Maintenant, répète après moi : '<corrected>'."
  c) Wait silently for their repetition — do NOT continue the conversation yet.
  d) When the correction system sends [STUDENT REPEATED CORRECTLY], praise them briefly
     ("Très bien ! Parfait !") and then resume naturally.
  e) When the correction system sends [REPEAT LIMIT REACHED], acknowledge briefly
     ("C'est presque parfait, on continue !") and resume.
  f) Do NOT read the technical content of [CORRECTION REQUIRED] verbatim — translate
     it into natural, spoken French.

**Pronunciation tips to model naturally:**
- Nasal vowels (an, en, in, on, un).
- Silent final consonants ("vous parlez" — the 'z' is silent).
- Liaison ("vous avez" → "vou-zavez").
- The difference between u /y/ and ou /u/.

**System Controls:**
- "pause please" → acknowledge and wait.
- "let's continue" → resume.
- "end session" → short warm goodbye in French, then output exactly [SESSION_END].
- Do NOT generate an English report yourself.`;

const CORRECTION_PROMPT = `You are an expert French language corrector specialising in A1-level learners.
Analyse the student utterance below and respond ONLY with a JSON object (no markdown
fences) matching this schema exactly:

{
  "has_errors": true | false,
  "corrected": "<full corrected French sentence, or empty string if no errors>",
  "errors": [
    {
      "type": "grammar | vocabulary | pronunciation_note | word_order | spelling",
      "original": "<the problematic fragment>",
      "correction": "<the correct form>",
      "explanation": "<concise English explanation, max 15 words>",
      "phonetic_hint": "<optional IPA or simple phonetic guide for pronunciation errors>"
    }
  ],
  "pronunciation_focus": "<one key pronunciation point to drill, or empty string>",
  "encouragement": "<one short English sentence of positive reinforcement>"
}

Rules:
- For pronunciation_note errors, always include a phonetic_hint.
- If the utterance is in English instead of French, set has_errors=true and note it as
  a vocabulary error with the French equivalent.
- Be strict but kind — flag real errors, not stylistic choices.

Student utterance (French): UTTERANCE_PLACEHOLDER`;

const EVAL_PROMPT = `You are a French language assessor. Based on the full session transcript below, write a
concise performance report in English for the student. Structure it as markdown with these sections:

## Strengths
## Pronunciation Notes
## Grammar & Vocabulary
## Overall Score (X / 10)

Pay special attention to recurring pronunciation issues.

Transcript:
TRANSCRIPT_PLACEHOLDER`;

/* ─── State ───────────────────────────────────── */
const S = {
  ws:           null,
  isConnected:  false,
  sessionEnded: false,
  paused:       false,

  ptState:      'idle', // 'idle'|'waiting_mic'|'recording'|'processing'

  audioCtx:     null,
  playTime:     0,

  stream:       null,
  micSrc:       null,
  spNode:       null,
  micSR:        48000,

  // Track recording duration to reject too-short utterances
  recordStartedAt: 0,

  repeatAttempt:  0,
  repeatRequested:false,
  pendingCorr:    null,

  fallback:     null,
  transcript:   [],
};

const MIN_RECORD_MS = 350;

/* ─── DOM ─────────────────────────────────────── */
const Q = id => document.getElementById(id);
const tutorAvatar      = Q('tutorAvatar');        // idle orb
const tutorAvatarActive= Q('tutorAvatarActive');  // active orb
const avatarIdleWrap   = Q('avatarIdleWrap');
const avatarActiveWrap = Q('avatarActiveWrap');
const statusPill       = Q('statusPill');
const btnEnd           = Q('btnEnd');
const transcriptBox    = Q('transcriptBox');
const btnConnect       = Q('btnConnect');
const btnSpeak         = Q('btnSpeak');
const speakLabel       = Q('speakLabel');
const correctionFeed   = Q('correctionFeed');
const evalModal        = Q('evalModal');
const evalBody         = Q('evalBody');
const btnCloseModal    = Q('btnCloseModal');

/* ─── Utilities ───────────────────────────────── */
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function stripJson(raw) {
  return raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
}

function mdToHtml(md) {
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^## (.+)$/gm,'<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/\n\n+/g,'</p><p>');
}

function setPill(text, cls) {
  statusPill.textContent = text;
  statusPill.className = `status-pill${cls ? ' '+cls : ''}`;
}

function setAvatar(on) {
  tutorAvatar.classList.toggle('speaking', on);
  tutorAvatarActive.classList.toggle('speaking', on);
}

/* ─── Transcript: student only ───────────────── */
function clearEmpty() {
  const e = transcriptBox.querySelector('.transcript-empty');
  if (e) e.remove();
}

function addStudentUtt(text) {
  clearEmpty();
  const bar = transcriptBox.querySelector('.tutor-speaking-bar');
  if (bar) bar.remove();
  const d = document.createElement('div');
  d.className = 'utt-bubble';
  d.textContent = text;
  transcriptBox.appendChild(d);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function showTutorSpeaking() {
  clearEmpty();
  if (transcriptBox.querySelector('.tutor-speaking-bar')) return;
  const d = document.createElement('div');
  d.className = 'tutor-speaking-bar';
  d.innerHTML = `<div class="dot"></div><div class="dot"></div><div class="dot"></div>
    <span>Professeur Dominique is speaking…</span>`;
  transcriptBox.appendChild(d);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function addTutorUtt(text) {
  clearEmpty();
  const d = document.createElement('div');
  d.className = 'tutor-bubble';
  d.dataset.text = text;
  d.dataset.revealed = 'false';
  d.innerHTML = `<i class="fas fa-eye" style="font-size:.75rem;opacity:.6"></i>
    <span class="tutor-bubble-label">Click to show text</span>`;
  d.addEventListener('click', () => {
    if (d.dataset.revealed === 'false') {
      d.dataset.revealed = 'true';
      d.innerHTML = `<i class="fas fa-graduation-cap" style="font-size:.75rem;opacity:.6"></i>
        <span class="tutor-bubble-label">${esc(text)}</span>`;
    } else {
      d.dataset.revealed = 'false';
      d.innerHTML = `<i class="fas fa-eye" style="font-size:.75rem;opacity:.6"></i>
        <span class="tutor-bubble-label">Click to show text</span>`;
    }
  });
  transcriptBox.appendChild(d);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function hideTutorSpeaking() {
  const b = transcriptBox.querySelector('.tutor-speaking-bar');
  if (b) b.remove();
}

/* ─── Correction panel ────────────────────────── */
function clearFeedEmpty() {
  const e = correctionFeed.querySelector('.feed-empty');
  if (e) e.remove();
}

function renderCorrection(result) {
  clearFeedEmpty();
  const entry = document.createElement('div');
  entry.className = 'c-entry';

  if (!result.has_errors) {
    entry.className += ' c-ok';
    entry.innerHTML = `<div class="c-head">
      <i class="fas fa-check-circle"></i>
      <span>${esc(result.encouragement || 'Great French!')}</span>
    </div>`;
  } else {
    entry.className += ' c-err';
    let h = `<div class="c-head">
      <i class="fas fa-exclamation-circle"></i>
      <span>${esc(result.encouragement || 'Keep trying!')}</span>
    </div>`;
    if (result.corrected) {
      h += `<div class="c-corrected">
        <i class="fas fa-pen"></i>&nbsp;<strong>Corrected:</strong>
        <span class="c-corrected-text">${esc(result.corrected)}</span>
      </div>`;
    }
    if (result.errors && result.errors.length) {
      h += '<ul class="c-errors">';
      for (const e of result.errors) {
        const tp = (e.type||'').replace(/_/g,' ');
        h += `<li>
          <span class="c-type">${esc(tp)}</span>
          <code>${esc(e.original||'')}</code>
          <i class="fas fa-arrow-right" style="font-size:.65rem;color:#64748b"></i>
          <code class="ok">${esc(e.correction||'')}</code>
          <span class="c-explain">— ${esc(e.explanation||'')}</span>
          ${e.phonetic_hint ? `<span style="color:#93c5fd;font-family:monospace;font-size:.77rem">[${esc(e.phonetic_hint)}]</span>` : ''}
        </li>`;
      }
      h += '</ul>';
    }
    if (result.pronunciation_focus) {
      h += `<div class="c-pron">
        <i class="fas fa-volume-up"></i> <strong>Pronunciation focus:</strong>
        ${esc(result.pronunciation_focus)}
      </div>`;
    }
    entry.innerHTML = h;
  }
  correctionFeed.appendChild(entry);
  correctionFeed.scrollTop = correctionFeed.scrollHeight;
}

/* ─── Audio output ────────────────────────────── */
function ensureCtx() {
  if (!S.audioCtx || S.audioCtx.state === 'closed') {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.playTime = 0;
  }
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
}

function playChunk(buf) {
  ensureCtx();
  const ctx = S.audioCtx;
  const i16 = new Int16Array(buf);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const ab = ctx.createBuffer(1, f32.length, OUT_SR);
  ab.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = ab; src.connect(ctx.destination);
  const now = ctx.currentTime;
  if (S.playTime < now) S.playTime = now;
  src.start(S.playTime);
  S.playTime += ab.duration;
  setAvatar(true);
  showTutorSpeaking();
  src.onended = () => {
    if (S.playTime <= ctx.currentTime + 0.05) { setAvatar(false); hideTutorSpeaking(); }
  };
}

/* ─── Mic ─────────────────────────────────────── */
function resample(f32in, srcSR) {
  if (srcSR === OUT_SR) return f32in;
  const ratio = srcSR / OUT_SR;
  const out = new Float32Array(Math.floor(f32in.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const s = i * ratio, lo = Math.floor(s), hi = Math.min(lo+1, f32in.length-1);
    out[i] = f32in[lo]*(1-(s-lo)) + f32in[hi]*(s-lo);
  }
  return out;
}

function toB64(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++)
    i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i]*32768)));
  const u8 = new Uint8Array(i16.buffer);
  let bin = '';
  for (let i = 0; i < u8.length; i += 8192)
    bin += String.fromCharCode(...u8.subarray(i, i+8192));
  return btoa(bin);
}

async function startMic() {
  ensureCtx();
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
  } catch(err) {
    console.error('[mic]', err);
    alert('Microphone access denied: ' + err.message);
    return false;
  }
  const ctx = S.audioCtx;
  S.micSR = (S.stream.getAudioTracks()[0].getSettings().sampleRate) || ctx.sampleRate || 48000;
  console.log('[mic] SR =', S.micSR);
  S.micSrc = ctx.createMediaStreamSource(S.stream);
  S.spNode = ctx.createScriptProcessor(4096, 1, 1);
  S.spNode.onaudioprocess = evt => {
    if (S.ptState !== 'recording') return;
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
    const raw = evt.inputBuffer.getChannelData(0);
    S.ws.send(JSON.stringify({ type:'input_audio_buffer.append', audio: toB64(resample(raw, S.micSR)) }));
  };
  S.micSrc.connect(S.spNode);
  S.spNode.connect(ctx.destination);
  return true;
}

function stopMic() {
  if (S.spNode)  { S.spNode.disconnect();  S.spNode  = null; }
  if (S.micSrc)  { S.micSrc.disconnect();  S.micSrc  = null; }
  if (S.stream)  { S.stream.getTracks().forEach(t=>t.stop()); S.stream = null; }
}

/* ─── WebSocket ───────────────────────────────── */
function wsSend(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}
function wsSendText(text) {
  wsSend({ type:'conversation.item.create',
    item:{ type:'message', role:'user', content:[{type:'input_text',text}] }});
}

/* ─── Click-to-toggle recording ──────────────── */
/**
 * Single-click to START recording, single-click again to STOP.
 * States: 'idle' → 'waiting_mic' → 'recording' → 'processing' → 'idle'
 */
async function toggleRecord() {
  console.log('[ptt] toggle, state =', S.ptState);

  // If currently recording → stop and send
  if (S.ptState === 'recording') {
    commitAudio();
    return;
  }

  // If waiting for mic permission → cancel
  if (S.ptState === 'waiting_mic') {
    S.ptState = 'idle';
    btnSpeak.classList.remove('recording');
    speakLabel.textContent = 'Click to Speak';
    setPill('Cancelled', '');
    return;
  }

  // Only start from idle
  if (!S.isConnected || S.sessionEnded || S.paused) return;
  if (S.ptState !== 'idle') return;

  S.ptState = 'waiting_mic';
  btnSpeak.classList.add('recording');
  speakLabel.textContent = 'Starting mic…';
  setPill('Mic starting…', 'busy');

  const ok = await startMic();
  if (!ok) {
    S.ptState = 'idle';
    btnSpeak.classList.remove('recording');
    speakLabel.textContent = 'Click to Speak';
    setPill('Mic denied', '');
    return;
  }

  // Still 'waiting_mic' means mic is ready — start recording
  if (S.ptState !== 'waiting_mic') return; // was cancelled while waiting

  S.ptState = 'recording';
  S.recordStartedAt = Date.now();
  speakLabel.textContent = 'Recording… Click to send';
  setPill('Recording…', 'busy');
}

function commitAudio() {
  // Reject too-short recordings
  const duration = Date.now() - S.recordStartedAt;
  if (duration < MIN_RECORD_MS) {
    stopMic();
    // Discard whatever was buffered server-side so the next turn starts clean
    wsSend({ type:'input_audio_buffer.clear' });
    S.ptState = 'idle';
    btnSpeak.classList.remove('recording');
    btnSpeak.disabled = false;
    speakLabel.textContent = 'Click to Speak';
    setPill('Too short — please try again', '');
    return;
  }

  stopMic();
  S.ptState = 'processing';
  btnSpeak.classList.remove('recording');
  speakLabel.textContent = 'Click to Speak';
  btnSpeak.disabled = true;
  setPill('Processing…', 'busy');

  // Only commit the audio here — response.create is fired inside
  // handleTranscript() after the correction agent returns, so any
  // [CORRECTION REQUIRED] instruction is injected before the tutor's
  // response for this turn (instead of leaking into the next turn).
  wsSend({ type:'input_audio_buffer.commit' });

  clearTimeout(S.fallback);
  S.fallback = setTimeout(() => {
    if (S.ptState === 'processing') {
      console.warn('[ptt] fallback');
      S.ptState = 'idle'; btnSpeak.disabled = false;
      setPill('Your turn — click to speak', 'active');
    }
  }, FALLBACK_MS);
}

/* ─── Correction agent (via Realtime WS — bypasses CORS) ─── */
async function runCorrection(utterance) {
  const prompt = CORRECTION_PROMPT.replace('UTTERANCE_PLACEHOLDER', utterance);
  try {
    return await window.OpenAIWS.chatJSON({
      apiKey: OPENAI_API_KEY,
      messages: [{ role:'user', content: prompt }],
      temperature: 0.6,   // Realtime API minimum
      maxTokens: 800
    });
  } catch(e) { console.error('[corr]', e); return { has_errors:false, encouragement:'Keep going!' }; }
}

async function handleTranscript(utt) {
  const result = await runCorrection(utt);
  renderCorrection(result);

  // Build the instruction for THIS turn (not the next), inject it before
  // requesting the tutor response, then fire response.create exactly once.
  let instruction = null;

  if (result.has_errors && S.repeatAttempt < MAX_REPEAT) {
    const corrected = result.corrected || utt;
    const errs = (result.errors||[]).map(e => {
      const type = (e.type||'').replace(/_/g,' ');
      const hint = e.phonetic_hint ? ` [${e.phonetic_hint}]` : '';
      return `${type}: '${e.original}' → '${e.correction}'${hint}`;
    }).join('; ');
    const pron = result.pronunciation_focus ? ` Key pronunciation focus: ${result.pronunciation_focus}.` : '';
    instruction =
      `[CORRECTION REQUIRED] ` +
      `The student made errors in their last utterance. ` +
      `Corrected French: "${corrected}". ` +
      `Errors: ${errs}.${pron} ` +
      `You MUST: (1) say the corrected sentence aloud clearly and slowly, ` +
      `(2) ask the student to repeat after you. ` +
      `Do NOT continue the conversation yet.`;
    S.repeatAttempt++; S.repeatRequested = true;
  } else if (!result.has_errors && S.repeatRequested) {
    instruction =
      `[STUDENT REPEATED CORRECTLY] ` +
      `The student just repeated the corrected phrase correctly. ` +
      `Give brief praise in French, then resume the conversation naturally.`;
    S.repeatAttempt = 0; S.repeatRequested = false;
  } else if (result.has_errors && S.repeatAttempt >= MAX_REPEAT) {
    const corrected = result.corrected || utt;
    instruction =
      `[REPEAT LIMIT REACHED] ` +
      `The student has attempted the correction ${MAX_REPEAT} time(s). ` +
      `Say the corrected form one final time: "${corrected}", ` +
      `then briefly acknowledge their effort and resume naturally.`;
    S.repeatAttempt = 0; S.repeatRequested = false;
  }

  // Inject the instruction (if any) for THIS turn, then ask for the response.
  if (instruction) wsSendText(instruction);
  wsSend({ type:'response.create', response:{ output_modalities:['audio'] } });
}

/* ─── Evaluation agent (via Realtime WS — bypasses CORS) ─── */
async function runEval() {
  const txt = S.transcript.map(t=>`[${t.role.toUpperCase()}] ${t.text}`).join('\n');
  const prompt = EVAL_PROMPT.replace('TRANSCRIPT_PLACEHOLDER', txt);
  try {
    return await window.OpenAIWS.chat({
      apiKey: OPENAI_API_KEY,
      messages: [{ role:'user', content: prompt }],
      temperature: 0.6,
      maxTokens: 1500
    });
  } catch(e) { console.error('[eval]', e); return '## Error\nCould not generate report: ' + e.message; }
}

async function endSession() {
  S.sessionEnded = true; S.ptState = 'idle';
  stopMic(); clearTimeout(S.fallback);
  btnSpeak.disabled = true; btnEnd.style.display = 'none';
  setPill('Generating evaluation…', 'busy');
  evalModal.style.display = 'flex';
  evalBody.innerHTML = '<div class="loading-spin"><i class="fas fa-spinner fa-spin"></i> Generating evaluation…</div>';
  const report = await runEval();
  evalBody.innerHTML = mdToHtml(report);
  setPill('Session ended', '');
}

/* ─── WebSocket messages ──────────────────────── */
let tutorBuf = [];

function onMsg(e) {
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  const t = msg.type || '';

  // Debug: log every event type the first time we see it
  if (!window.__seenEvts) window.__seenEvts = new Set();
  if (!window.__seenEvts.has(t)) {
    window.__seenEvts.add(t);
    console.log('[evt new]', t);
  }

  // Audio chunk — GA uses output_audio.delta, beta used audio.delta
  if (t === 'response.output_audio.delta' || t === 'response.audio.delta') {
    const raw = atob(msg.delta);
    const buf = new ArrayBuffer(raw.length);
    const v = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) v[i] = raw.charCodeAt(i);
    playChunk(buf);
    return;
  }

  // Audio transcript (tutor speech as text) — GA renamed to output_audio_transcript
  if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    tutorBuf.push(msg.delta || '');
    return;
  }

  if (t === 'response.done') {
    clearTimeout(S.fallback);
    if (tutorBuf.length) {
      const text = tutorBuf.join('').trim(); tutorBuf = [];
      S.transcript.push({ role:'tutor', text });
      if (text.includes('[SESSION_END]')) { endSession(); return; }
      // Show tutor turn as click-to-reveal bubble
      addTutorUtt(text);
    }
    setAvatar(false); hideTutorSpeaking();
    S.ptState = 'idle'; btnSpeak.disabled = false;
    setPill('Your turn — click to speak', 'active');
    return;
  }

  if (t === 'conversation.item.input_audio_transcription.completed') {
    const utt = (msg.transcript || '').trim();
    if (!utt) return;
    console.log('[transcript]', utt);
    addStudentUtt(utt);
    S.transcript.push({ role:'student', text:utt });
    const lo = utt.toLowerCase();
    if (lo.includes('pause please')) { S.paused = true; setPill('Paused', ''); }
    else if (lo.includes("let's continue") && S.paused) { S.paused = false; setPill('Your turn — click to speak', 'active'); }
    handleTranscript(utt);  // runs correction in background
    return;
  }

  if (t === 'error') {
    console.error('[ws error]', msg);
    setPill('API error: ' + (msg.error?.message||'?'), '');
    if (S.ptState === 'processing') { S.ptState = 'idle'; btnSpeak.disabled = false; }
  }
}

/* ─── Chapter loading ──────────────────────────── */
async function loadChapterContext() {
  if (!CHAPTER_ID) return null;
  try {
    const r = await fetch('tables/chapters/' + encodeURIComponent(CHAPTER_ID));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const c = await r.json();
    if (!c || c.deleted || c.module !== 'conversation') {
      console.warn('[chapter] invalid or wrong module', c);
      return null;
    }
    chapterCtx = c;

    // Show chapter title in the avatar subtitle if present
    const subtitleEls = document.querySelectorAll('.avatar-subtitle');
    if (subtitleEls.length && c.title) {
      subtitleEls.forEach(el => { el.textContent = c.title; });
    }
    // Display chapter context banner under the avatar (idle wrap)
    const idleWrap = document.getElementById('avatarIdleWrap');
    if (idleWrap && c.title) {
      const banner = document.createElement('div');
      banner.className = 'chapter-banner';
      banner.innerHTML =
        `<i class="fas fa-book-open"></i> Chapter: <strong>${esc(c.title)}</strong>` +
        (c.description ? `<div class="cb-desc">${esc(c.description)}</div>` : '');
      idleWrap.appendChild(banner);
    }
    return c;
  } catch (e) {
    console.error('[chapter] load failed', e);
    return null;
  }
}

function buildSystemPrompt() {
  let prompt = SYSTEM_PROMPT;
  if (!chapterCtx) return prompt;

  const parts = [];
  parts.push('\n\n---');
  parts.push(`**Current chapter:** ${chapterCtx.title || 'Untitled'}`);
  if (chapterCtx.description) {
    parts.push(`**Chapter description:** ${chapterCtx.description}`);
  }
  if (chapterCtx.custom_prompt && chapterCtx.custom_prompt.trim()) {
    parts.push('\n**Teacher\'s instructions for this chapter (follow them strictly while keeping the rules above):**');
    parts.push(chapterCtx.custom_prompt.trim());
  }
  const mats = Array.isArray(chapterCtx.materials) ? chapterCtx.materials : [];
  const textMats = mats.filter(m => m.kind === 'text' && m.text);
  const imgMats  = mats.filter(m => m.kind === 'image');
  if (textMats.length) {
    parts.push('\n**Reference materials (extracted text from teacher uploads — use them to guide the conversation):**');
    textMats.forEach((m, i) => {
      parts.push(`\n[Material ${i+1}: ${m.name}]`);
      parts.push(m.text);
    });
  }
  if (imgMats.length) {
    parts.push(`\n**Reference images:** ${imgMats.length} image(s) attached to this chapter. You may refer to them when prompting the student about objects or vocabulary.`);
  }
  return prompt + parts.join('\n');
}

/* ─── Connect ─────────────────────────────────── */
async function connect() {
  btnConnect.style.display = 'none';
  ensureCtx();
  tutorBuf = []; S.sessionEnded = false; S.transcript = []; S.ptState = 'idle';

  // Load chapter context (if any) BEFORE establishing the WS session,
  // because session.update is sent once at connection time.
  await loadChapterContext();
  const systemPrompt = buildSystemPrompt();

  const ws = new WebSocket(REALTIME_URL, [
    'realtime',
    `openai-insecure-api-key.${OPENAI_API_KEY}`
  ]);
  S.ws = ws;

  ws.onopen = () => {
    console.log('[ws] open');
    // GA Realtime API schema (gpt-realtime, 2025-08)
    wsSend({
      type:'session.update',
      session:{
        type:'realtime',
        model:'gpt-realtime',
        output_modalities:['audio'],
        instructions:systemPrompt,
        audio:{
          input:{
            format:{ type:'audio/pcm', rate:24000 },
            transcription:{ model:'whisper-1', language:'fr' },
            turn_detection:null
          },
          output:{
            format:{ type:'audio/pcm', rate:24000 },
            voice:'shimmer'
          }
        }
      }
    });
    const openingHint = chapterCtx
      ? `Bonjour ! Please start the session now with a brief greeting, and let the student know we will focus on this chapter: "${chapterCtx.title}".`
      : 'Bonjour ! Please start the session now with a brief greeting.';
    wsSendText(openingHint);
    wsSend({ type:'response.create', response:{ output_modalities:['audio'] } });

    S.isConnected = true;
    S.ptState = 'processing';
    // switch avatar stage: hide idle, show active
    avatarIdleWrap.style.display  = 'none';
    avatarActiveWrap.style.display = '';
    btnEnd.style.display = '';
    btnSpeak.style.display = '';
    btnSpeak.disabled = true;
    speakLabel.textContent = 'Click to Speak';
    setPill('Professeur Dominique is greeting you… please wait', 'active');
    showTutorSpeaking();
  };

  ws.onmessage = onMsg;

  ws.onerror = e => {
    console.error('[ws] error', e);
    btnConnect.style.display = '';
    setPill('Connection failed', '');
  };

  ws.onclose = e => {
    console.log('[ws] closed', e.code, e.reason);
    S.isConnected = false;
    if (!S.sessionEnded) {
      setPill(`Disconnected (${e.code})`, '');
      avatarActiveWrap.style.display = 'none';
      avatarIdleWrap.style.display   = '';
      stopMic(); S.ptState = 'idle'; btnSpeak.disabled = true;
    }
    stopMic(); setAvatar(false); hideTutorSpeaking();
  };
}

/* ─── Download corrections as .docx ─────────── */
const btnDownload = Q('btnDownload');

function buildDocxXml(entries) {
  const now = new Date().toLocaleString();
  const esc = s => String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');

  const para = (text, opts = {}) => {
    const bold  = opts.bold  ? '<w:b/>' : '';
    const color = opts.color ? `<w:color w:val="${opts.color}"/>` : '';
    const size  = opts.size  ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '';
    const indent= opts.indent? `<w:ind w:left="${opts.indent}"/>` : '';
    const space = opts.space ? `<w:spacing w:after="${opts.space}"/>` : '<w:spacing w:after="80"/>';
    return `<w:p><w:pPr>${indent}${space}</w:pPr><w:r><w:rPr>${bold}${color}${size}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  };

  const divider = () =>
    `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:color w:val="4B5563"/></w:rPr><w:t>${'─'.repeat(50)}</w:t></w:r></w:p>`;

  let body = '';
  // Title
  body += para('French AI Tutor — Correction Report', { bold:true, size:32, color:'1D4ED8', space:'120' });
  body += para('Generated: ' + now, { color:'6B7280', size:18, space:'200' });

  Array.from(entries).forEach((el, idx) => {
    body += para(`Turn ${idx + 1}`, { bold:true, size:22, color:'1E40AF', space:'60' });

    if (el.classList.contains('c-ok')) {
      const head = el.querySelector('.c-head span');
      body += para('✓ ' + (head ? head.textContent.trim() : 'Great French!'), { color:'166534', bold:true });
    } else {
      const head = el.querySelector('.c-head span');
      if (head) body += para('⚠ ' + head.textContent.trim(), { color:'92400E', bold:true });

      const corrected = el.querySelector('.c-corrected-text');
      if (corrected) {
        body += para('Corrected:  ' + corrected.textContent.trim(), { color:'0E7490', indent:360 });
      }

      el.querySelectorAll('.c-errors li').forEach(li => {
        const type    = li.querySelector('.c-type');
        const codes   = li.querySelectorAll('code');
        const explain = li.querySelector('.c-explain');
        const orig = codes[0] ? codes[0].textContent.trim() : '';
        const corr = codes[1] ? codes[1].textContent.trim() : '';
        const tp   = type    ? '[' + type.textContent.trim() + '] ' : '';
        const exp  = explain ? '  ' + explain.textContent.trim() : '';
        body += para(`${tp}${orig} → ${corr}${exp}`, { indent:720, color:'374151' });
      });

      const pron = el.querySelector('.c-pron');
      if (pron) body += para('🔊 ' + pron.textContent.replace(/\s+/g,' ').trim(), { color:'1D4ED8', indent:360 });
    }
    body += divider();
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>`;
}

async function downloadCorrections() {
  const entries = correctionFeed.querySelectorAll('.c-entry');
  if (!entries.length) { alert('No corrections to download yet.'); return; }

  const docXml  = buildDocxXml(entries);
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  // Use JSZip (loaded via CDN) to build the .docx
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/document.xml', docXml);
  zip.file('word/_rels/document.xml.rels', docRels);

  const blob = await zip.generateAsync({ type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'corrections_' + new Date().toISOString().slice(0,10) + '.docx';
  a.click();
  URL.revokeObjectURL(url);
}

btnDownload.addEventListener('click', downloadCorrections);

/* ─── Event wiring ────────────────────────────── */
btnConnect.addEventListener('click', connect);

// Single click toggles record on / record off
btnSpeak.addEventListener('click', e => { e.preventDefault(); toggleRecord(); });
btnSpeak.addEventListener('touchend', e => { e.preventDefault(); toggleRecord(); }, { passive:false });

btnEnd.addEventListener('click', () => {
  if (S.sessionEnded) return;
  wsSendText('end session');
  wsSend({ type:'response.create', response:{ output_modalities:['audio'] } });
});

btnCloseModal.addEventListener('click', () => { evalModal.style.display = 'none'; });

document.addEventListener('click', () => {
  if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();
}, { passive:true });
