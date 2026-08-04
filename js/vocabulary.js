/**
 * vocabulary.js
 * Vocabulary Practice — OpenAI Realtime API + push-to-talk
 *
 * LEFT panel shows ONLY:
 *   - Image upload → Analyze → Start Session flow
 *   - Your spoken words (student transcript only — NO tutor text)
 *   - A single "Hold to Speak" button
 *   - Tutor avatar animates while model audio plays
 *
 * RIGHT panel shows:
 *   - Correction entries (matching Python _display_correction_panel output)
 */

/* ─── Config ──────────────────────────────────── */
// API key is fetched at runtime from the user's browser (localStorage).
// See js/api-key.js — never hardcode a key here.
const OPENAI_API_KEY = window.getApiKey ? window.getApiKey() : '';
const REALTIME_URL     = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const VISION_MODEL     = "gpt-4o";
const CORRECTION_MODEL = "gpt-4o";
const EVALUATION_MODEL = "gpt-4o";
const OUT_SR           = 24000;   // API output sample rate
const FALLBACK_MS      = 20000;   // safety re-enable timeout

/* ─── Chapter context (loaded from ?chapter=ID) ─── */
const CHAPTER_ID = new URLSearchParams(location.search).get('chapter') || null;
let chapterCtx = null;   // full chapter row

/* ─── Prompts ─────────────────────────────────── */
const IMAGE_PROMPT = `Analyze this image for a French vocabulary teaching exercise.
Return ONLY valid JSON (no markdown fences):
{
  "scene_description_fr": "<1-2 sentence French scene description>",
  "objects": [
    {
      "name_fr": "<French name>",
      "article_def": "<le/la/les>",
      "article_indef": "<un/une/des>",
      "name_en": "<English name>",
      "position": "<position in French>",
      "color_fr": "<color in French or empty>"
    }
  ],
  "spatial_description_fr": "<2-3 sentences in French>",
  "suggested_questions_fr": ["<q1>","<q2>","<q3>","<q4>","<q5>"]
}`;

const CORRECTION_PROMPT = `Tu es un correcteur expert en langue française spécialisé dans le vocabulaire et les articles.
Analyse l'énoncé de l'élève. Réponds UNIQUEMENT avec un objet JSON valide (sans balises markdown) :
{
  "has_errors": true,
  "corrected": "<phrase corrigée ou chaîne vide>",
  "errors": [
    {
      "type": "article | gender_agreement | vocabulary | pronunciation_note | word_order | missing_word",
      "original": "<fragment problématique>",
      "correction": "<forme correcte>",
      "explanation": "<explication concise en anglais, max 20 mots>"
    }
  ],
  "vocabulary_ok": true,
  "encouragement": "<phrase d'encouragement courte en anglais>"
}
Énoncé de l'élève : UTTERANCE_PLACEHOLDER`;

const EVAL_PROMPT = `You are a French language assessor evaluating a vocabulary session.
Write a SHORT English performance report as markdown. Be concise — 2-3 bullet points per section maximum.

## Strengths
## Key Errors
## Article Usage
## Overall Score (X / 10)

Transcript:
TRANSCRIPT_PLACEHOLDER`;

/* ─── State ───────────────────────────────────── */
const S = {
  imageData:    null,
  imageAnalysis:null,

  ws:           null,
  isConnected:  false,
  sessionEnded: false,
  paused:       false,

  // click-to-toggle state machine
  // 'idle' | 'waiting_mic' | 'recording' | 'processing'
  ptState:      'idle',

  // audio output
  audioCtx:     null,
  playTime:     0,

  // mic
  stream:       null,
  micSrc:       null,
  spNode:       null,
  micSR:        48000,

  fallback:     null,
  transcript:   [],
};

/* ─── DOM ─────────────────────────────────────── */
const Q = id => document.getElementById(id);

const sessionImageWrap = Q('sessionImageWrap');
const sessionImage     = Q('sessionImage');
const uploadZone       = Q('uploadZone');
const fileInput        = Q('fileInput');
const previewWrap      = Q('previewWrap');
const imgPreview       = Q('imgPreview');
const btnChange        = Q('btnChange');
const btnAnalyze       = Q('btnAnalyze');
const stepUpload       = Q('stepUpload');
const stepAnalysis     = Q('stepAnalysis');
const contextBox       = Q('contextBox');
const btnStart         = Q('btnStart');
const stepSession      = Q('stepSession');
const tutorAvatar      = Q('tutorAvatar');
const tutorAvatarActive= Q('tutorAvatarActive');
const statusPill       = Q('statusPill');
const btnEnd           = Q('btnEnd');
const transcriptBox    = Q('transcriptBox');
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
  if (tutorAvatarActive) tutorAvatarActive.classList.toggle('speaking', on);
}

/* ─── Transcript: student speech only ────────── */
function clearEmpty() {
  const e = transcriptBox.querySelector('.transcript-empty');
  if (e) e.remove();
}

function addStudentUtt(text) {
  clearEmpty();
  // remove any tutor-speaking indicator
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
  const bar = transcriptBox.querySelector('.tutor-speaking-bar');
  if (bar) bar.remove();
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
        const tp = (e.type || '').replace(/_/g,' ');
        h += `<li>
          <span class="c-type">${esc(tp)}</span>
          <code>${esc(e.original||'')}</code>
          <i class="fas fa-arrow-right" style="font-size:.65rem;color:#64748b"></i>
          <code class="ok">${esc(e.correction||'')}</code>
          <span class="c-explain">— ${esc(e.explanation||'')}</span>
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

  // newest on top
  correctionFeed.appendChild(entry);
  correctionFeed.scrollTop = correctionFeed.scrollHeight;
}

/* ─── Audio output (PCM16 24kHz → AudioContext) ─ */
function ensureCtx() {
  if (!S.audioCtx || S.audioCtx.state === 'closed') {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.playTime = 0;
  }
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
}

function playChunk(arrayBuf) {
  ensureCtx();
  const ctx = S.audioCtx;
  const i16 = new Int16Array(arrayBuf);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const ab = ctx.createBuffer(1, f32.length, OUT_SR);
  ab.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(ctx.destination);

  const now = ctx.currentTime;
  if (S.playTime < now) S.playTime = now;
  src.start(S.playTime);
  S.playTime += ab.duration;

  setAvatar(true);
  showTutorSpeaking();
  src.onended = () => {
    if (S.playTime <= ctx.currentTime + 0.05) {
      setAvatar(false);
      hideTutorSpeaking();
    }
  };
}

/* ─── Mic capture ─────────────────────────────── */
function resample(f32in, srcSR) {
  if (srcSR === OUT_SR) return f32in;
  const ratio  = srcSR / OUT_SR;
  const outLen = Math.floor(f32in.length / ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = i * ratio;
    const lo = Math.floor(s), hi = Math.min(lo+1, f32in.length-1);
    out[i] = f32in[lo]*(1-(s-lo)) + f32in[hi]*(s-lo);
  }
  return out;
}

function toB64Pcm16(f32) {
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
  } catch (err) {
    console.error('[mic]', err);
    alert('Microphone access denied: ' + err.message);
    return false;
  }
  const ctx = S.audioCtx;
  const track = S.stream.getAudioTracks()[0];
  S.micSR = (track.getSettings().sampleRate) || ctx.sampleRate || 48000;
  console.log('[mic] sampleRate =', S.micSR);

  S.micSrc = ctx.createMediaStreamSource(S.stream);
  S.spNode = ctx.createScriptProcessor(4096, 1, 1);
  S.spNode.onaudioprocess = evt => {
    if (S.ptState !== 'recording') return;
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
    const raw = evt.inputBuffer.getChannelData(0);
    S.ws.send(JSON.stringify({ type:'input_audio_buffer.append', audio: toB64Pcm16(resample(raw, S.micSR)) }));
  };
  S.micSrc.connect(S.spNode);
  S.spNode.connect(ctx.destination);
  return true;
}

function stopMic() {
  if (S.spNode)  { S.spNode.disconnect();  S.spNode  = null; }
  if (S.micSrc)  { S.micSrc.disconnect();  S.micSrc  = null; }
  if (S.stream)  { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
}

/* ─── WebSocket ───────────────────────────────── */
function wsSend(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
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
  speakLabel.textContent = 'Recording… Click to send';
  setPill('Recording…', 'busy');
}

function commitAudio() {
  stopMic();
  S.ptState = 'processing';
  btnSpeak.classList.remove('recording');
  speakLabel.textContent = 'Click to Speak';
  btnSpeak.disabled = true;
  setPill('Processing…', 'busy');

  wsSend({ type: 'input_audio_buffer.commit' });
  wsSend({ type: 'response.create', response: { output_modalities: ['audio'] } });

  clearTimeout(S.fallback);
  S.fallback = setTimeout(() => {
    if (S.ptState === 'processing') {
      console.warn('[ptt] fallback — re-enabling');
      S.ptState = 'idle';
      btnSpeak.disabled = false;
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
      temperature: 0.6,    // Realtime API minimum
      maxTokens: 800
    });
  } catch(e) {
    console.error('[correction]', e);
    return { has_errors:false, encouragement:'Keep going!' };
  }
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
  } catch(e) {
    console.error('[eval]', e);
    return '## Error\nCould not generate report: ' + e.message;
  }
}

async function endSession() {
  S.sessionEnded = true;
  S.ptState = 'idle';
  stopMic();
  clearTimeout(S.fallback);
  btnSpeak.disabled = true;
  btnEnd.style.display = 'none';
  setPill('Generating evaluation…', 'busy');
  evalModal.style.display = 'flex';
  evalBody.innerHTML = '<div class="loading-spin"><i class="fas fa-spinner fa-spin"></i> Generating evaluation report…</div>';
  const report = await runEval();
  evalBody.innerHTML = mdToHtml(report);
  setPill('Session ended', '');
}

/* ─── WebSocket messages ──────────────────────── */
let tutorBuf = [];

function onMsg(e) {
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  const t = msg.type || '';

  // Debug: log every distinct event type once
  if (!window.__seenEvts) window.__seenEvts = new Set();
  if (!window.__seenEvts.has(t)) {
    window.__seenEvts.add(t);
    console.log('[evt new]', t);
  }

  // Audio chunk — GA uses output_audio.delta
  if (t === 'response.output_audio.delta' || t === 'response.audio.delta') {
    const raw = atob(msg.delta);
    const buf = new ArrayBuffer(raw.length);
    const v   = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) v[i] = raw.charCodeAt(i);
    playChunk(buf);
    return;
  }

  // Audio transcript (tutor speech as text) — GA renamed
  if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    tutorBuf.push(msg.delta || '');
    return;
  }

  if (t === 'response.done') {
    clearTimeout(S.fallback);
    if (tutorBuf.length) {
      const text = tutorBuf.join('').trim();
      tutorBuf = [];
      S.transcript.push({ role:'tutor', text });
      if (text.includes('[SESSION_END]')) { endSession(); return; }
      // Show tutor turn as click-to-reveal bubble
      addTutorUtt(text);
    }
    // Tutor finished speaking
    setAvatar(false);
    hideTutorSpeaking();
    S.ptState = 'idle';
    btnSpeak.disabled = false;
    setPill('Your turn — click to speak', 'active');
    return;
  }

  if (t === 'conversation.item.input_audio_transcription.completed') {
    const utt = (msg.transcript || '').trim();
    if (!utt) return;
    console.log('[transcript]', utt);

    // Show student's words in transcript box
    addStudentUtt(utt);
    S.transcript.push({ role:'student', text:utt });

    const lo = utt.toLowerCase();
    if (['pause','une pause'].some(w => lo.includes(w))) {
      S.paused = true; setPill('Paused', '');
    } else if (['continuer','on continue'].some(w => lo.includes(w)) && S.paused) {
      S.paused = false; setPill('Your turn — click to speak', 'active');
    }

    // Run correction agent in background → render in right panel
    runCorrection(utt).then(renderCorrection);
    return;
  }

  if (t === 'error') {
    console.error('[ws error]', msg);
    setPill('API error', '');
    if (S.ptState === 'processing') {
      S.ptState = 'idle'; btnSpeak.disabled = false;
    }
  }
}

/* ─── Build system prompt ─────────────────────── */
function buildPrompt(data) {
  const objs = (data.objects||[]).map(o=>`${o.article_def} ${o.name_fr} (${o.position})`).join(', ');
  const qs   = (data.suggested_questions_fr||[]).map(q=>`- ${q}`).join('\n');
  let base = `Tu es un professeur de français nommé Professeur Dominique qui fait pratiquer le vocabulaire à un élève.
L'élève regarde une image que tu connais parfaitement.

**IMAGE:**
Scène : ${data.scene_description_fr||''}
Objets : ${objs}
Espace : ${data.spatial_description_fr||''}

**RÈGLES:**
- Parle UNIQUEMENT en français.
- Réponses COURTES : 1–3 phrases.
- Aide l'élève à nommer les objets avec les bons articles.
- Commence par saluer et poser la première question.

**PROGRESSION:**
- ${(data.objects||[]).length} objets à couvrir.
- Questions suggérées (varie-les) :
${qs}

**FIN DE SESSION:** Si l'élève dit "terminer" → au revoir + émettre [SESSION_END].`;

  // Append chapter context if a chapter is loaded
  if (chapterCtx) {
    const parts = ['\n\n---', `**Chapitre actuel:** ${chapterCtx.title || ''}`];
    if (chapterCtx.description) parts.push(`**Description:** ${chapterCtx.description}`);
    if (chapterCtx.custom_prompt && chapterCtx.custom_prompt.trim()) {
      parts.push('\n**Instructions du professeur pour ce chapitre (à suivre strictement) :**');
      parts.push(chapterCtx.custom_prompt.trim());
    }
    const mats = Array.isArray(chapterCtx.materials) ? chapterCtx.materials : [];
    const textMats = mats.filter(m => m.kind === 'text' && m.text);
    if (textMats.length) {
      parts.push('\n**Matériel de référence (texte extrait des fichiers téléversés) :**');
      textMats.forEach((m, i) => {
        parts.push(`\n[Document ${i+1}: ${m.name}]`);
        parts.push(m.text);
      });
    }
    base += parts.join('\n');
  }
  return base;
}

/* ─── Chapter loader ─────────────────────────────
   If URL has ?chapter=ID, load it. If the chapter has an image material,
   auto-populate S.imageData so the student skips the upload step.       */
async function loadChapter() {
  if (!CHAPTER_ID) return null;
  try {
    const r = await fetch('tables/chapters/' + encodeURIComponent(CHAPTER_ID));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const c = await r.json();
    if (!c || c.deleted || c.module !== 'vocabulary') {
      console.warn('[chapter] invalid or wrong module', c);
      return null;
    }
    chapterCtx = c;

    // Visual hint on the page (next to the upload section title, if present)
    const ctxTitle = document.querySelector('.left-card h2, .step-title');
    if (ctxTitle && c.title) {
      const banner = document.createElement('div');
      banner.className = 'chapter-banner';
      banner.style.margin = '0 0 0.6rem';
      banner.innerHTML =
        `<i class="fas fa-book-open"></i> Chapter: <strong>${esc(c.title)}</strong>` +
        (c.description ? `<div class="cb-desc">${esc(c.description)}</div>` : '');
      ctxTitle.parentNode.insertBefore(banner, ctxTitle.nextSibling);
    }

    // Auto-load first image material from the chapter so the student
    // doesn't have to upload anything.
    const mats = Array.isArray(c.materials) ? c.materials : [];
    const firstImg = mats.find(m => m.kind === 'image' && m.dataUrl);
    if (firstImg) {
      S.imageData = firstImg.dataUrl;
      if (typeof imgPreview !== 'undefined' && imgPreview) imgPreview.src = S.imageData;
      if (typeof uploadZone !== 'undefined' && uploadZone) uploadZone.style.display = 'none';
      if (typeof previewWrap !== 'undefined' && previewWrap) previewWrap.style.display = '';
      if (typeof btnAnalyze !== 'undefined' && btnAnalyze) btnAnalyze.disabled = false;
    }
    return c;
  } catch (e) {
    console.error('[chapter] load failed', e);
    return null;
  }
}

// Kick off chapter load as soon as the script runs
document.addEventListener('DOMContentLoaded', loadChapter);
// Also run immediately in case DOMContentLoaded already fired:
if (document.readyState !== 'loading') loadChapter();

/* ─── Connect Realtime ────────────────────────── */
function connectRealtime(systemPrompt) {
  ensureCtx();
  tutorBuf = [];
  S.sessionEnded = false;
  S.transcript   = [];
  S.ptState      = 'idle';

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
    // Trigger greeting
    wsSend({ type:'conversation.item.create',
      item:{ type:'message', role:'user',
        content:[{ type:'input_text', text:'Bonjour ! Commencez la session maintenant.' }] }});
    wsSend({ type:'response.create', response:{ output_modalities:['audio'] } });

    S.isConnected = true;
    S.ptState     = 'processing';   // wait for greeting to finish
    btnSpeak.disabled = true;
    setPill('Professeur Dominique is greeting you… please wait', 'active');
    showTutorSpeaking();
  };

  ws.onmessage = onMsg;

  ws.onerror = e => {
    console.error('[ws] error', e);
    setPill('Connection error — see console', '');
  };

  ws.onclose = e => {
    console.log('[ws] closed', e.code, e.reason);
    S.isConnected = false;
    if (!S.sessionEnded) setPill(`Disconnected (${e.code})`, '');
    stopMic(); setAvatar(false); hideTutorSpeaking();
  };
}

/* ─── Image analysis (via Realtime WebSocket — bypasses CORS) ─── */
async function analyzeImage() {
  btnAnalyze.disabled = true;
  btnAnalyze.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing…';

  const imgData = S.imageData || '';
  const imgKB = (imgData.length / 1024).toFixed(1);
  console.log('[analyzeImage] image size:', imgKB, 'KB   via Realtime WS');

  if (!imgData || !imgData.startsWith('data:')) {
    alert('No valid image loaded. Please upload an image first.');
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<i class="fas fa-search"></i> Analyze Image';
    return;
  }
  if (!window.OpenAIWS) {
    alert('Helper script not loaded (openai-ws-rest.js). Refresh the page.');
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<i class="fas fa-search"></i> Analyze Image';
    return;
  }

  try {
    const t0 = performance.now();
    S.imageAnalysis = await window.OpenAIWS.chatJSON({
      apiKey: OPENAI_API_KEY,
      messages: [{
        role: 'user',
        content: [
          { type: 'text',      text: IMAGE_PROMPT },
          { type: 'image_url', image_url: { url: imgData } }
        ]
      }],
      temperature: 0.6,   // Realtime API minimum is 0.6
      maxTokens: 1500
    });
    console.log('[analyzeImage] completed in',
                ((performance.now() - t0) / 1000).toFixed(2), 's');

    renderContext(S.imageAnalysis);
    stepUpload.style.display   = 'none';
    stepAnalysis.style.display = '';
  } catch (e) {
    console.error('[analyzeImage]', e);
    alert('Image analysis failed: ' + e.message);
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<i class="fas fa-search"></i> Analyze Image';
  }
}

function renderContext(data) {
  const objs = data.objects || [];
  let h = `<div class="ctx-scene"><strong>Scene:</strong> ${esc(data.scene_description_fr||'')}</div>`;
  h += `<div class="ctx-objs"><strong>Objects (${objs.length}):</strong><ul>`;
  for (const o of objs) {
    h += `<li>
      <span class="obj-fr">${esc(o.article_def)} ${esc(o.name_fr)}</span>
      — <span class="obj-en">${esc(o.name_en)}</span>
      <span class="obj-pos">[${esc(o.position)}]</span>
    </li>`;
  }
  h += `</ul></div>`;
  contextBox.innerHTML = h;
}

/* ─── Event wiring ────────────────────────────── */

// Upload
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

function loadFile(file) {
  if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    S.imageData = ev.target.result;
    imgPreview.src = S.imageData;
    uploadZone.style.display = 'none';
    previewWrap.style.display = '';
    btnAnalyze.disabled = false;
  };
  reader.readAsDataURL(file);
}

btnChange.addEventListener('click', () => {
  S.imageData = null; S.imageAnalysis = null;
  imgPreview.src = '';
  uploadZone.style.display = ''; previewWrap.style.display = 'none';
  btnAnalyze.disabled = true;
  btnAnalyze.innerHTML = '<i class="fas fa-search"></i> Analyze Image';
});

btnAnalyze.addEventListener('click', analyzeImage);

btnStart.addEventListener('click', () => {
  if (!S.imageAnalysis) return;
  stepAnalysis.style.display = 'none';
  stepSession.style.display  = '';
  // Show the uploaded image inside the session panel
  sessionImage.src             = S.imageData || '';
  sessionImageWrap.style.display = S.imageData ? '' : 'none';
  connectRealtime(buildPrompt(S.imageAnalysis));
});

// Download corrections
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
      if (corrected) body += para('Corrected:  ' + corrected.textContent.trim(), { color:'0E7490', indent:360 });

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

// Push-to-talk → now click-to-toggle
btnSpeak.addEventListener('click', e => { e.preventDefault(); toggleRecord(); });
btnSpeak.addEventListener('touchend', e => { e.preventDefault(); toggleRecord(); }, { passive:false });

// End session
btnEnd.addEventListener('click', () => {
  if (S.sessionEnded) return;
  wsSend({ type:'conversation.item.create',
    item:{ type:'message', role:'user', content:[{type:'input_text',text:'terminer'}] }});
  wsSend({ type:'response.create', response:{ output_modalities:['audio'] } });
});

btnCloseModal.addEventListener('click', () => { evalModal.style.display = 'none'; });

document.addEventListener('click', () => {
  if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume();
}, { passive:true });
