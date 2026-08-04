/**
 * grammar.js
 * Grammar Practice — OpenAI Realtime API
 *
 * LEFT panel:
 *   - Avatar + Start Session button
 *   - Transcript (student + tutor click-to-reveal bubbles)
 *   - Single "Click to Speak" toggle button
 *
 * RIGHT panel:
 *   - Grammar Correction entries (3-stage: repeat → alternatives → give answer)
 *   - Download as .docx
 */

/* ─── Config ──────────────────────────────────── */
// API key is fetched at runtime from the user's browser (localStorage).
// See js/api-key.js — never hardcode a key here.
const OPENAI_API_KEY = window.getApiKey ? window.getApiKey() : '';
const REALTIME_URL     = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const CORRECTION_MODEL = "gpt-4o";
const EVALUATION_MODEL = "gpt-4o";
const OUT_SR           = 24000;
const FALLBACK_MS      = 20000;

/* ─── System Prompt ───────────────────────────── */
const SYSTEM_PROMPT = `Tu es Professeur Dominique, un professeur de français expert qui fait pratiquer la grammaire française à un élève par des exercices oraux structurés.

**TON RÔLE:**
- Parle UNIQUEMENT en français, tout le temps — jamais en anglais.
- Garde tes réponses COURTES : 1 à 3 phrases maximum par tour.
- Tu choisis librement les points de grammaire à pratiquer selon le niveau de l'élève (A1-B2).
- Tu proposes des exercices variés : conjugaisons, accords, prépositions, temps verbaux, négation, subjonctif, etc.
- Tu guides l'élève phrase par phrase, en t'adaptant à ses erreurs.

**DÉBUT DE SESSION:**
1. Salue brièvement l'élève.
2. Propose un premier exercice de grammaire simple (ex : passé composé, accord du participe, prépositions).
3. Donne une consigne claire avec un exemple modèle.
4. Attends la réponse de l'élève.

**STRATÉGIE DE CORRECTION (RESPECTE CET ORDRE STRICT):**

Étape 1 — DEMANDER DE RÉPÉTER :
Si la réponse est grammaticalement incorrecte, demande à l'élève de répéter en soulignant le mot/la forme incorrecte. Ne donne PAS la réponse.
Exemples : "Attention à la conjugaison ! Essayez encore." / "Presque ! Réfléchissez à l'accord. Répétez."

Étape 2 — PROPOSER DES ALTERNATIVES :
Si toujours incorrecte, propose 2-3 alternatives (dont la bonne) et demande de choisir.
Exemples : "C'est 'allé' ou 'allée' ?" / "On dit 'au', 'à la' ou 'en' ici ?"

Étape 3 — DONNER LA RÉPONSE :
Seulement après deux échecs, donne la bonne réponse et demande de répéter.
Exemples : "La bonne réponse est : '...'. Répétez après moi."

**APRÈS UNE RÉPONSE CORRECTE:**
- Confirme brièvement : "Très bien !", "Parfait !", "Excellent !"
- Passe immédiatement à l'exercice suivant.

**PROGRESSION:**
- Après chaque réponse correcte, enchaîne sur un nouvel exercice de grammaire.
- Varie les structures grammaticales : ne répète pas le même type d'exercice deux fois de suite.
- Adapte la difficulté selon les performances de l'élève.

**IMPOSITION DU FRANÇAIS:**
- Si l'élève parle anglais, réponds : "S'il vous plaît, répondez en français !" puis répète la consigne.

**CONTRÔLE DE SESSION:**
- Si l'élève dit "pause" → accuse réception et attends.
- Si l'élève dit "continuer" → reprends la session.
- Si l'élève dit "terminer" ou "fin" → dis au revoir chaleureusement, puis émets le token exact [SESSION_END].`.trim();

/* ─── Correction Prompt ───────────────────────── */
const CORRECTION_PROMPT = `Tu es un correcteur expert en langue française, spécialisé dans la grammaire (conjugaisons, accords, prépositions, temps verbaux, négation) pour les élèves de niveau A1-B2.

Analyse l'énoncé de l'élève ci-dessous dans le cadre d'un exercice de grammaire française.

Réponds UNIQUEMENT avec un objet JSON valide (sans balises markdown) :
{
  "has_errors": true,
  "corrected": "<phrase française corrigée, ou chaîne vide si pas d'erreurs>",
  "error_stage": "repeat | suggest_alternatives | give_answer",
  "errors": [
    {
      "type": "conjugation | tense | agreement | preposition | word_order | vocabulary | negation | missing_word | extra_word",
      "original": "<le fragment problématique>",
      "correction": "<la forme correcte>",
      "explanation": "<explication concise en anglais, 20 mots max>",
      "phonetic_hint": "<guide phonétique optionnel>"
    }
  ],
  "grammar_score": 0,
  "pronunciation_focus": "<un point clé de prononciation, ou chaîne vide>",
  "encouragement": "<courte phrase d'encouragement en anglais>"
}

Pour "error_stage" :
- "repeat" si les erreurs sont mineures (l'élève peut se corriger seul)
- "suggest_alternatives" si les erreurs sont plus importantes
- "give_answer" si la réponse est très éloignée de ce qui est attendu

Énoncé de l'élève (en français) : UTTERANCE_PLACEHOLDER`;

/* ─── Evaluation Prompt ───────────────────────── */
const EVAL_PROMPT = `You are a French language assessor evaluating a grammar practice session.
Write a SHORT English performance report as markdown. Be concise — 2-3 bullet points per section maximum.

## Grammar Performance
## Conjugation & Tense Usage
## Strengths
## Overall Score (X / 10)

Transcript:
TRANSCRIPT_PLACEHOLDER`;

/* ─── State ───────────────────────────────────── */
const S = {
  ws:           null,
  isConnected:  false,
  sessionEnded: false,
  paused:       false,

  correctionStage: 0,   // per-utterance 3-stage correction tracker

  // click-to-toggle: 'idle' | 'waiting_mic' | 'recording' | 'processing'
  ptState:      'idle',

  audioCtx:     null,
  playTime:     0,
  stream:       null,
  micSrc:       null,
  spNode:       null,
  micSR:        48000,

  fallback:     null,
  transcript:   [],
};

/* ─── DOM ─────────────────────────────────────── */
const Q = id => document.getElementById(id);

const avatarIdleWrap   = Q('avatarIdleWrap');
const avatarActiveWrap = Q('avatarActiveWrap');
const tutorAvatar      = Q('tutorAvatar');
const tutorAvatarActive= Q('tutorAvatarActive');
const btnConnect       = Q('btnConnect');
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
  statusPill.className = `status-pill${cls ? ' ' + cls : ''}`;
}

function setAvatar(on) {
  tutorAvatar.classList.toggle('speaking', on);
  if (tutorAvatarActive) tutorAvatarActive.classList.toggle('speaking', on);
}

/* ─── Transcript helpers ──────────────────────── */
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

function hideTutorSpeaking() {
  const bar = transcriptBox.querySelector('.tutor-speaking-bar');
  if (bar) bar.remove();
}

function addTutorUtt(text) {
  clearEmpty();
  hideTutorSpeaking();
  const d = document.createElement('div');
  d.className = 'tutor-bubble';
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

/* ─── Correction panel ────────────────────────── */
function clearFeedEmpty() {
  const e = correctionFeed.querySelector('.feed-empty');
  if (e) e.remove();
}

const STAGE_LABELS = {
  1: 'Stage 1 — Try again',
  2: 'Stage 2 — Choose answer',
  3: 'Stage 3 — Answer given'
};

function renderCorrection(result) {
  clearFeedEmpty();
  const entry = document.createElement('div');

  if (!result.has_errors) {
    entry.className = 'c-entry c-ok';
    entry.innerHTML = `
      <div class="c-head">
        <i class="fas fa-check-circle"></i>
        <span>${esc(result.encouragement || 'Excellent français !')}</span>
      </div>`;
  } else {
    const stageLabel = STAGE_LABELS[S.correctionStage] || 'Correction';
    entry.className = 'c-entry c-err';
    let html = `
      <div class="c-head">
        <i class="fas fa-exclamation-circle"></i>
        <span>${esc(result.encouragement || 'Keep working on it!')}</span>
        <span class="c-type">${esc(stageLabel)}</span>
      </div>`;

    if (result.corrected) {
      html += `<div class="c-corrected">
        <i class="fas fa-pen"></i>&nbsp;<strong>Corrected:</strong>
        <span class="c-corrected-text">${esc(result.corrected)}</span>
      </div>`;
    }

    if (result.errors && result.errors.length) {
      html += `<ul class="c-errors">`;
      for (const err of result.errors) {
        html += `<li>
          <span class="c-type">${esc((err.type || '').replace(/_/g, ' '))}</span>
          <code>${esc(err.original || '')}</code> → <code>${esc(err.correction || '')}</code>
          <span class="c-explain">${esc(err.explanation || '')}</span>
          ${err.phonetic_hint ? `<div class="c-pron">🔊 ${esc(err.phonetic_hint)}</div>` : ''}
        </li>`;
      }
      html += `</ul>`;
    }

    if (result.grammar_score !== undefined && result.grammar_score !== '') {
      html += `<div class="c-pron">📊 Grammar score: ${esc(String(result.grammar_score))} / 5</div>`;
    }
    if (result.pronunciation_focus) {
      html += `<div class="c-pron">🔊 ${esc(result.pronunciation_focus)}</div>`;
    }

    entry.innerHTML = html;
  }

  correctionFeed.appendChild(entry);
  correctionFeed.scrollTop = correctionFeed.scrollHeight;
}

/* ─── Audio output ────────────────────────────── */
function ensureCtx() {
  if (!S.audioCtx) {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_SR });
    S.playTime = 0;
  }
}

function resampleTo24k(pcm16Buffer, srcRate) {
  if (srcRate === OUT_SR) return pcm16Buffer;
  const samples = new Int16Array(pcm16Buffer);
  const ratio = srcRate / OUT_SR;
  const outLen = Math.round(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = Math.min(Math.floor(i * ratio), samples.length - 1);
    out[i] = samples[src];
  }
  return out.buffer;
}

function playChunk(arrayBuffer) {
  ensureCtx();
  const pcm16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
  const buf = S.audioCtx.createBuffer(1, float32.length, OUT_SR);
  buf.getChannelData(0).set(float32);
  const src = S.audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(S.audioCtx.destination);
  const now = S.audioCtx.currentTime;
  if (S.playTime < now) S.playTime = now;
  src.start(S.playTime);
  S.playTime += buf.duration;
}

/* ─── Microphone ──────────────────────────────── */
async function startMic() {
  S.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  ensureCtx();
  S.micSrc = S.audioCtx.createMediaStreamSource(S.stream);
  S.micSR  = S.audioCtx.sampleRate;

  await S.audioCtx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([`
      class PCMProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0][0];
          if (ch) this.port.postMessage(ch.slice());
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `], { type: 'application/javascript' }))
  );

  S.spNode = new AudioWorkletNode(S.audioCtx, 'pcm-processor');
  S.spNode.port.onmessage = ({ data: float32 }) => {
    if (S.ptState !== 'recording') return;
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      pcm16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }
    const resampled = resampleTo24k(pcm16.buffer, S.micSR);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(resampled)));
    wsSend({ type: 'input_audio_buffer.append', audio: b64 });
  };
  S.micSrc.connect(S.spNode);
}

function stopMic() {
  try { S.spNode?.disconnect(); } catch (_) {}
  try { S.micSrc?.disconnect(); } catch (_) {}
  if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
}

/* ─── WebSocket helpers ───────────────────────── */
function wsSend(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(obj));
  }
}

/* ─── Toggle record ───────────────────────────── */
function toggleRecord() {
  if (S.ptState === 'idle') {
    S.ptState = 'waiting_mic';
    btnSpeak.disabled = true;
    speakLabel.textContent = 'Starting mic…';

    startMic().then(() => {
      if (S.ptState !== 'waiting_mic') return;
      S.ptState = 'recording';
      btnSpeak.disabled = false;
      btnSpeak.classList.add('recording');
      speakLabel.textContent = 'Recording… Click to send';
    }).catch(err => {
      console.error('[mic]', err);
      S.ptState = 'idle';
      btnSpeak.disabled = false;
      speakLabel.textContent = 'Click to Speak';
      setPill('Microphone error', '');
    });

  } else if (S.ptState === 'recording') {
    S.ptState = 'processing';
    btnSpeak.classList.remove('recording');
    btnSpeak.disabled = true;
    speakLabel.textContent = 'Processing…';
    stopMic();
    wsSend({ type: 'input_audio_buffer.commit' });

    S.fallback = setTimeout(() => {
      if (S.ptState === 'processing') {
        S.ptState = 'idle';
        btnSpeak.disabled = false;
        speakLabel.textContent = 'Click to Speak';
        setPill('Your turn — click to speak', 'active');
      }
    }, FALLBACK_MS);
  }
}

/* ─── Correction Agent ────────────────────────── */
let tutorBuf = [];

async function runCorrection(utterance) {
  // via Realtime WS — bypasses CORS
  const prompt = CORRECTION_PROMPT.replace('UTTERANCE_PLACEHOLDER', utterance);
  try {
    return await window.OpenAIWS.chatJSON({
      apiKey: OPENAI_API_KEY,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      maxTokens: 800
    });
  } catch (e) {
    console.error('[correction]', e);
    return { has_errors: false, encouragement: 'Keep going!' };
  }
}

/* ─── Handle correction + inject instruction ─── */
async function handleCorrectionAndRespond(utterance) {
  const result = await runCorrection(utterance);
  renderCorrection(result);

  let instruction = '';

  if (result.has_errors) {
    S.correctionStage++;
    const errorsDetail = (result.errors || []).map(e =>
      `${(e.type || '').replace(/_/g, ' ')}: '${e.original}' → '${e.correction}'`
    ).join('; ');
    const corrected = result.corrected || '';
    const pron = result.pronunciation_focus || '';

    if (S.correctionStage === 1) {
      instruction = `[CORRECTION STAGE 1 - ASK TO REPEAT] The student made grammar errors. Errors: ${errorsDetail}. Ask the student to try again, highlighting what's wrong. Do NOT give the answer yet.`;
    } else if (S.correctionStage === 2) {
      instruction = `[CORRECTION STAGE 2 - SUGGEST ALTERNATIVES] The student still has errors. Errors: ${errorsDetail}. Correct answer: '${corrected}'. Propose 2-3 alternatives (including the correct one) and ask the student to choose. Do NOT reveal which is correct.`;
    } else {
      instruction = `[CORRECTION STAGE 3 - GIVE ANSWER] The student has failed twice. Give the correct answer: '${corrected}'. Ask them to repeat after you.${pron ? ' Pronunciation focus: ' + pron + '.' : ''}`;
    }
  } else {
    if (S.correctionStage > 0) {
      instruction = '[STUDENT CORRECTED SUCCESSFULLY] The student got it right after correction. Give brief praise then move to a new grammar exercise.';
    } else {
      instruction = '[CORRECT ANSWER] The student answered correctly on the first try. Give brief praise then move to a new grammar exercise.';
    }
    S.correctionStage = 0; // reset for next utterance
  }

  wsSend({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: instruction }] }
  });
  wsSend({ type: 'response.create', response: { output_modalities: ['audio'] } });
}

/* ─── Evaluation Agent ────────────────────────── */
async function runEval() {
  evalBody.innerHTML = '<div class="loading-spin"><i class="fas fa-spinner fa-spin"></i> Generating evaluation…</div>';
  evalModal.style.display = '';
  const transcriptText = S.transcript.map(t => `[${t.role.toUpperCase()}] ${t.text}`).join('\n');
  const prompt = EVAL_PROMPT.replace('TRANSCRIPT_PLACEHOLDER', transcriptText);
  try {
    // via Realtime WS — bypasses CORS
    const out = await window.OpenAIWS.chat({
      apiKey: OPENAI_API_KEY,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      maxTokens: 1500
    });
    evalBody.innerHTML = `<div class="modal-report">${mdToHtml(out.trim())}</div>`;
  } catch (e) {
    evalBody.innerHTML = `<p style="color:#f87171">Evaluation failed: ${esc(e.message)}</p>`;
  }
}

/* ─── WebSocket message handler ──────────────── */
function onMsg(e) {
  const msg = JSON.parse(e.data);
  const t = msg.type;

  // Debug: log every distinct event type once
  if (!window.__seenEvts) window.__seenEvts = new Set();
  if (!window.__seenEvts.has(t)) {
    window.__seenEvts.add(t);
    console.log('[evt new]', t);
  }

  // Audio chunk — GA uses output_audio.delta
  if (t === 'response.output_audio.delta' || t === 'response.audio.delta') {
    const ab = Uint8Array.from(atob(msg.delta), c => c.charCodeAt(0)).buffer;
    playChunk(ab);

  } else if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    tutorBuf.push(msg.delta || '');

  } else if (t === 'response.done') {
    clearTimeout(S.fallback);
    const tutorText = tutorBuf.join('').trim();
    tutorBuf = [];

    if (tutorText) {
      S.transcript.push({ role: 'tutor', text: tutorText });
      addTutorUtt(tutorText);

      if (tutorText.includes('[SESSION_END]')) {
        S.sessionEnded = true;
        setAvatar(false);
        hideTutorSpeaking();
        runEval();
        return;
      }
    }

    setAvatar(false);
    hideTutorSpeaking();
    S.ptState = 'idle';
    btnSpeak.disabled = false;
    speakLabel.textContent = 'Click to Speak';
    setPill('Your turn — click to speak', 'active');

  } else if (t === 'conversation.item.input_audio_transcription.completed') {
    const utterance = (msg.transcript || '').trim();
    if (utterance) {
      addStudentUtt(utterance);
      S.transcript.push({ role: 'student', text: utterance });

      const lower = utterance.toLowerCase();
      if (['pause', 'une pause', 'arrêt'].some(w => lower.includes(w))) {
        S.paused = true;
        setPill('Paused', '');
      } else if (['continuer', 'on continue', 'reprendre'].some(w => lower.includes(w)) && S.paused) {
        S.paused = false;
        setPill('Your turn — click to speak', 'active');
      }

      showTutorSpeaking();
      setAvatar(true);
      handleCorrectionAndRespond(utterance);
    }

  } else if (t === 'error') {
    console.error('[ws error]', msg);
    setPill('API error — see console', '');
    S.ptState = 'idle';
    btnSpeak.disabled = false;
    speakLabel.textContent = 'Click to Speak';
  }
}

/* ─── Connect ─────────────────────────────────── */
function connect() {
  ensureCtx();
  tutorBuf = [];
  S.sessionEnded   = false;
  S.transcript     = [];
  S.ptState        = 'idle';
  S.correctionStage= 0;

  avatarIdleWrap.style.display   = 'none';
  avatarActiveWrap.style.display = '';
  btnEnd.style.display  = '';
  btnSpeak.style.display= '';
  btnSpeak.disabled     = true;
  speakLabel.textContent= 'Click to Speak';
  setPill('Connecting…', 'busy');

  const ws = new WebSocket(REALTIME_URL, [
    'realtime',
    `openai-insecure-api-key.${OPENAI_API_KEY}`
  ]);
  S.ws = ws;

  ws.onopen = () => {
    // GA Realtime API schema (gpt-realtime, 2025-08)
    wsSend({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        output_modalities: ['audio'],
        instructions: SYSTEM_PROMPT,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'whisper-1', language: 'fr' },
            turn_detection: null
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'shimmer'
          }
        }
      }
    });

    wsSend({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bonjour ! Commencez la session de grammaire maintenant.' }] }
    });
    wsSend({ type: 'response.create', response: { output_modalities: ['audio'] } });

    S.isConnected = true;
    S.ptState = 'processing';
    btnSpeak.disabled = true;
    setPill('Professeur Dominique is greeting you… please wait', 'active');
    showTutorSpeaking();
    setAvatar(true);
  };

  ws.onmessage = onMsg;

  ws.onerror = e => {
    console.error('[ws]', e);
    setPill('Connection failed', '');
    avatarIdleWrap.style.display   = '';
    avatarActiveWrap.style.display = 'none';
  };

  ws.onclose = e => {
    S.isConnected = false;
    if (!S.sessionEnded) setPill(`Disconnected (${e.code})`, '');
    stopMic(); setAvatar(false); hideTutorSpeaking();
  };
}

/* ─── Download corrections (.docx) ───────────── */
function buildDocxXml(entries) {
  const now = new Date().toLocaleString();
  const xmlEsc = s => String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const para = (text, opts = {}) => {
    const bold   = opts.bold   ? '<w:b/>' : '';
    const color  = opts.color  ? `<w:color w:val="${opts.color}"/>` : '';
    const size   = opts.size   ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '';
    const indent = opts.indent ? `<w:ind w:left="${opts.indent}"/>` : '';
    const space  = opts.space  ? `<w:spacing w:after="${opts.space}"/>` : '<w:spacing w:after="80"/>';
    return `<w:p><w:pPr>${indent}${space}</w:pPr><w:r><w:rPr>${bold}${color}${size}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  };

  let body = '';
  body += para('French AI Tutor — Grammar Correction Report', { bold:true, size:32, color:'1D4ED8', space:'120' });
  body += para('Generated: ' + now, { color:'6B7280', size:18, space:'200' });

  Array.from(entries).forEach((el, idx) => {
    body += para(`Turn ${idx + 1}`, { bold:true, size:22, color:'1E40AF', space:'60' });
    if (el.classList.contains('c-ok')) {
      const head = el.querySelector('.c-head span');
      body += para('✓ ' + (head ? head.textContent.trim() : 'Correct!'), { color:'166534', bold:true });
    } else {
      const head = el.querySelector('.c-head span');
      if (head) body += para('⚠ ' + head.textContent.trim(), { color:'92400E', bold:true });
      const corrected = el.querySelector('.c-corrected-text');
      if (corrected) body += para('Corrected: ' + corrected.textContent.trim(), { color:'0E7490', indent:360 });
      el.querySelectorAll('.c-errors li').forEach(li => {
        body += para(li.textContent.trim().replace(/\s+/g,' '), { indent:360, color:'374151' });
      });
      el.querySelectorAll('.c-pron').forEach(p => {
        body += para(p.textContent.trim(), { indent:360, color:'6B7280' });
      });
    }
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;
}

async function downloadCorrections() {
  const entries = correctionFeed.querySelectorAll('.c-entry');
  if (!entries.length) { alert('No corrections to download yet.'); return; }

  const docXml = buildDocxXml(entries);
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/document.xml', docXml);
  zip.file('word/_rels/document.xml.rels', wordRels);

  const blob = await zip.generateAsync({ type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `grammar_corrections_${new Date().toISOString().slice(0,10)}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── Event wiring ────────────────────────────── */
btnConnect.addEventListener('click', connect);

btnSpeak.addEventListener('click',    e => { e.preventDefault(); toggleRecord(); });
btnSpeak.addEventListener('touchend', e => { e.preventDefault(); toggleRecord(); }, { passive: false });

btnEnd.addEventListener('click', () => {
  if (S.sessionEnded) return;
  wsSend({ type:'conversation.item.create', item:{ type:'message', role:'user', content:[{ type:'input_text', text:'terminer' }] } });
  wsSend({ type:'response.create', response:{ output_modalities:['audio'] } });
});

btnCloseModal.addEventListener('click', () => { evalModal.style.display = 'none'; });
Q('btnDownload').addEventListener('click', downloadCorrections);

document.addEventListener('click', () => {
  if (S.audioCtx?.state === 'suspended') S.audioCtx.resume();
});
