# -*- coding: utf-8 -*-
"""
French Oral Practice System  (v3 — spoken corrections + repeat-request)
Multi-Agent Architecture:
  - Conversation Agent : drives interactive French dialogue
  - Correction Agent   : detects grammar / pronunciation errors, gives feedback
  - Evaluation Agent   : end-of-session performance summary

Python 3.9+ compatible.
"""

import asyncio
import base64
import json
import os
import sys
import pyaudio
import websockets
import dotenv
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text
from openai import OpenAI

dotenv.load_dotenv()

# ──────────────────────────────────────────────
#  Audio config
# ──────────────────────────────────────────────
FORMAT = pyaudio.paInt16
CHANNELS = 1
SAMPLE_RATE = 24_000
CHUNK_SIZE = 1_024
VOLUME_THRESHOLD = 300

# ──────────────────────────────────────────────
#  OpenAI config
# ──────────────────────────────────────────────
REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
CORRECTION_MODEL = "gpt-4o"
EVALUATION_MODEL = "gpt-4o"

MAX_REPEAT_ATTEMPTS = 2

# ──────────────────────────────────────────────
#  Conversation Agent system prompt
# ──────────────────────────────────────────────
CONVERSATION_SYSTEM_PROMPT = """
You are a French language professor named Professeur Yves. Your
primary role is to help an A1-level student improve their spoken
French — especially pronunciation and grammar — through interactive
oral practice.

**Tone & Style:**
- Speak ONLY in simple French during normal conversation.
- Use a warm, encouraging, but precise teaching tone.
- Keep your spoken turns SHORT: 1–3 sentences maximum.

**Normal conversation flow:**
1. Open the session: "Bonjour ! Je m'appelle le professeur
Yves. Comment tu t'appelles ?"
2. Engage in natural, everyday-topic conversation — ask simple
follow-up questions.
3. After each student turn, check for any pronunciation or grammar
   issues you detect yourself, and model the correct forms naturally
   in your reply.

**CRITICAL — handling [CORRECTION REQUIRED] instructions:**
When you see a message that starts with [CORRECTION REQUIRED], it
means the correction system has detected specific errors in the
student's last utterance. You MUST:
  a) Immediately say the corrected version clearly and slightly slowly
     in French, e.g. "On dit : '<corrected sentence>'. Écoute bien."
  b) Ask the student to repeat: "Maintenant, répète après moi : '<corrected>'."
  c) Wait silently for their repetition — do NOT continue the conversation yet.
  d) When the correction system sends [STUDENT REPEATED CORRECTLY],
     praise them briefly ("Très bien ! Parfait !") and then resume
     naturally.
  e) When the correction system sends [REPEAT LIMIT REACHED],
     acknowledge briefly ("C'est presque parfait, on continue !") and
     resume.
  f) Do NOT read the technical content of [CORRECTION REQUIRED]
     verbatim — translate it into natural, spoken French.

**Pronunciation tips to model naturally:**
- Nasal vowels (an, en, in, on, un).
- Silent final consonants ("vous parlez" — the 'z' is silent).
- Liaison ("vous avez" → "vou-zavez").
- The difference between u /y/ and ou /u/.

**System Controls:**
- "pause please" → acknowledge and wait.
- "let's continue" → resume.
- "end session" → short warm goodbye in French, then output [SESSION_END].
- Do NOT generate an English report yourself.
""".strip()

# ──────────────────────────────────────────────
#  Correction Agent prompt
# ──────────────────────────────────────────────
CORRECTION_PROMPT_TEMPLATE = """
You are an expert French language corrector specialising in A1-level
learners.  Analyse the student utterance below and respond ONLY with a
JSON object (no markdown fences) matching this schema exactly:

{{
  "has_errors": true | false,
  "corrected": "<full corrected French sentence, or empty string if no
  errors>",
  "errors": [
    {{
      "type": "grammar | vocabulary | pronunciation_note | word_order
      | spelling",
      "original": "<the problematic fragment>",
      "correction": "<the correct form>",
      "explanation": "<concise English explanation, max 15 words>",
      "phonetic_hint": "<optional IPA or simple phonetic guide for
      pronunciation errors>"
    }}
  ],
  "pronunciation_focus": "<one key pronunciation point to drill, or
  empty string>",
  "encouragement": "<one short English sentence of positive reinforcement>"
}}

Rules:
- For pronunciation_note errors, always include a phonetic_hint.
- If the utterance is in English instead of French, set
  has_errors=true and note it as a vocabulary error with the French
  equivalent.
- Be strict but kind — flag real errors, not stylistic choices.

Student utterance (French): {utterance}
""".strip()

# ──────────────────────────────────────────────
#  Evaluation Agent prompt
# ──────────────────────────────────────────────
EVALUATION_PROMPT_TEMPLATE = """
You are a French language assessor. Based on the full session
transcript below, write a concise performance report in English for
the student. Structure it as markdown with these sections:

## Session Summary
## Strengths 💪
## Pronunciation Notes 🔊
## Grammar & Vocabulary 📝
## Areas to Improve
## Recommended Practice
## Overall Score  (format: X / 10)

Pay special attention to recurring pronunciation issues.

Transcript:
{transcript}
""".strip()


# ══════════════════════════════════════════════
#  Correction Agent
# ══════════════════════════════════════════════
async def run_correction_agent(client: OpenAI, utterance: str) -> dict:
    prompt = CORRECTION_PROMPT_TEMPLATE.format(utterance=utterance)

    def _call():
        resp = client.chat.completions.create(
            model=CORRECTION_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw)

    return await asyncio.to_thread(_call)


# ══════════════════════════════════════════════
#  Evaluation Agent
# ══════════════════════════════════════════════
async def run_evaluation_agent(client: OpenAI, transcript: list) -> str:
    transcript_text = "\n".join(
        f"[{t['role'].upper()}] {t['text']}" for t in transcript
    )
    prompt = EVALUATION_PROMPT_TEMPLATE.format(transcript=transcript_text)

    def _call():
        resp = client.chat.completions.create(
            model=EVALUATION_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        return resp.choices[0].message.content.strip()

    return await asyncio.to_thread(_call)


# ══════════════════════════════════════════════
#  Main session
# ══════════════════════════════════════════════
class FrenchTutorSession:

    def __init__(self):
        self.console = Console()
        self.pya = pyaudio.PyAudio()
        self.oai_client = OpenAI(api_key=OPENAI_API_KEY)

        # NOTE: on Python 3.9 asyncio.Queue() binds to the
        # currently-running loop at construction time. Create them
        # lazily inside run() where the loop is live.
        self.audio_in_queue = None
        self.audio_out_queue = None

        self.paused = False
        self.session_ended = False
        self.transcript = []

        self.speaking = False
        self.recording = False
        self.assistant_speaking = True
        self.audio_chunks_recorded = 0
        self.ws = None

        self.repeat_attempt = 0
        self.repeat_requested = False

    async def _send(self, payload: dict):
        await self.ws.send(json.dumps(payload))

    async def _configure_session(self):
        await self._send({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": CONVERSATION_SYSTEM_PROMPT,
                "voice": "shimmer",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": "whisper-1", "language": "fr"},
                "turn_detection": None,
                "temperature": 0.8,
            },
        })
        self.console.print("[bold green]✅  Session configured[/bold green]")

    async def _send_initial_message(self):
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text":
                    "Bonjour ! Please start the session "
                    "now with a brief greeting.",
                }],
            },
        })
        await self._send({
            "type": "response.create",
            "response": {"modalities": ["text", "audio"]},
        })

    async def _listen_mic(self):
        mic_info = self.pya.get_default_input_device_info()
        stream = self.pya.open(
            format=FORMAT, channels=CHANNELS, rate=SAMPLE_RATE,
            input=True, input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        self.console.print("🎤  [yellow]Microphone ready[/yellow]")

        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.05)
                continue

            data = await asyncio.to_thread(
                stream.read, CHUNK_SIZE, exception_on_overflow=False)

            if not self.recording:
                continue

            self.audio_chunks_recorded += 1

            samples = [
                int.from_bytes(data[i:i+2], "little", signed=True)
                for i in range(0, len(data), 2)
            ]
            volume = sum(abs(s) for s in samples) / len(samples)
            if volume > VOLUME_THRESHOLD:
                if not self.speaking:
                    self.console.print("\n🎙️  ", end="")
                    self.speaking = True
                self.console.print("▪", end="", style="green")
            else:
                if self.speaking:
                    self.speaking = False

            await self.audio_in_queue.put(data)

        stream.stop_stream()
        stream.close()

    async def _send_audio(self):
        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.05)
                continue
            chunk = await self.audio_in_queue.get()
            await self._send({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode(),
            })

    async def _play_audio(self):
        stream = self.pya.open(
            format=FORMAT, channels=CHANNELS, rate=SAMPLE_RATE,
            output=True, frames_per_buffer=CHUNK_SIZE,
        )
        while not self.session_ended:
            chunk = await self.audio_out_queue.get()
            if chunk is None:
                break
            await asyncio.to_thread(stream.write, chunk)

        stream.stop_stream()
        stream.close()

    async def _keyboard_control(self):
        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.1)
                continue

            while self.assistant_speaking and not self.session_ended:
                await asyncio.sleep(0.1)

            if self.session_ended:
                break

            try:
                import termios
                termios.tcflush(sys.stdin, termios.TCIFLUSH)
            except Exception:
                pass

            self.console.print(
                "\n[bold cyan]🟢 Press ENTER to start speaking...[/bold cyan]",
                end=""
            )
            try:
                await asyncio.to_thread(input)
            except EOFError:
                break

            if self.session_ended:
                break

            self.recording = True
            self.audio_chunks_recorded = 0
            self.console.print(
                "🔴 [bold red]Recording... Press ENTER to stop.[/bold red]",
                end=""
            )
            try:
                await asyncio.to_thread(input)
            except EOFError:
                break

            self.recording = False

            if self.audio_chunks_recorded < 3:
                self.console.print(
                    "\n[yellow]⚠️  Too short — please try again.[/yellow]")
                continue

            self.console.print("\n⏳ [dim]Processing…[/dim]")
            await self._send({"type": "input_audio_buffer.commit"})

            # response.create is deferred to _handle_correction_and_respond()
            self.assistant_speaking = True

    async def _receive_events(self):
        tutor_text_buffer = []

        async for raw in self.ws:
            event = json.loads(raw)
            etype = event.get("type", "")

            if etype == "response.audio.delta":
                pcm = base64.b64decode(event["delta"])
                await self.audio_out_queue.put(pcm)

            elif (
                    etype ==
                    "conversation.item.input_audio_transcription.completed"
            ):
                utterance = event.get("transcript", "").strip()
                if utterance:
                    self.console.print(
                        f"\n👤 [bold cyan]You:[/bold cyan] {utterance}")
                    self.transcript.append({
                        "role": "student", "text": utterance})

                    lower = utterance.lower()
                    if "pause please" in lower:
                        self.paused = True
                        self.console.print(
                            "⏸️  [yellow]Paused. Say 'let's continue' t"
                            "o resume.[/yellow]"
                        )
                    elif "let's continue" in lower and self.paused:
                        self.paused = False
                        self.console.print("▶️  [green]Resumed.[/green]")

                    asyncio.ensure_future(
                        self._handle_correction_and_respond(utterance))

            elif etype == "response.audio_transcript.delta":
                tutor_text_buffer.append(event.get("delta", ""))

            elif etype == "response.done":
                if tutor_text_buffer:
                    tutor_text = "".join(tutor_text_buffer).strip()
                    tutor_text_buffer.clear()
                    self.transcript.append({
                        "role": "tutor",
                        "text": tutor_text
                    })
                    self.console.print(
                        Panel(
                            Markdown(tutor_text),
                            title="🤖 Professeur Yves",
                            border_style="blue",
                        )
                    )
                    if "[SESSION_END]" in tutor_text:
                        self.session_ended = True
                        await self.audio_out_queue.put(None)
                        await self._end_session()
                        return

                self.assistant_speaking = False

            elif etype == "error":
                self.console.print(f"[red]API error: {event}[/red]")

    async def _handle_correction_and_respond(self, utterance: str):
        try:
            result = await run_correction_agent(self.oai_client, utterance)
        except Exception as e:
            self.console.print(f"[red]Correction Agent error: {e}[/red]")
            result = {"has_errors": False, "encouragement": "Keep going!"}

        self._display_correction_panel(result)

        has_errors = result.get("has_errors", False)
        instruction = None

        if has_errors and self.repeat_attempt < MAX_REPEAT_ATTEMPTS:
            corrected = result.get("corrected", utterance)
            errors_detail = "; ".join(
                "{}: '{}' → '{}'{}".format(
                    e["type"].replace("_", " "),
                    e["original"],
                    e["correction"],
                    " [{}]".format(e["phonetic_hint"]) if e.get(
                        "phonetic_hint") else "",
                )
                for e in result.get("errors", [])
            )
            pron = result.get("pronunciation_focus", "")
            pron_line = " Key pronunciation focus: {}.".format(
                pron) if pron else ""

            instruction = (
                "[CORRECTION REQUIRED] "
                "The student made errors in their last utterance. "
                "Corrected French: \"{}\". "
                "Errors: {}.{} "
                "You MUST: (1) say the corrected sentence "
                "aloud clearly and slowly, "
                "(2) ask the student to repeat after you. "
                "Do NOT continue the conversation yet."
            ).format(corrected, errors_detail, pron_line)

            self.repeat_attempt += 1
            self.repeat_requested = True

        elif not has_errors and self.repeat_requested:
            instruction = (
                "[STUDENT REPEATED CORRECTLY] "
                "The student just repeated the corrected phrase correctly. "
                "Give brief praise in French, then resume "
                "the conversation naturally."
            )
            self.repeat_attempt = 0
            self.repeat_requested = False

        elif has_errors and self.repeat_attempt >= MAX_REPEAT_ATTEMPTS:
            corrected = result.get("corrected", utterance)
            instruction = (
                "[REPEAT LIMIT REACHED] "
                "The student has attempted the correction {} time(s). "
                "Say the corrected form one final time: \"{}\", "
                "then briefly acknowledge their effort and resume naturally."
            ).format(MAX_REPEAT_ATTEMPTS, corrected)
            self.repeat_attempt = 0
            self.repeat_requested = False

        if instruction:
            await self._send({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": instruction}],
                },
            })

        await self._send({
            "type": "response.create",
            "response": {"modalities": ["text", "audio"]},
        })

    def _display_correction_panel(self, result: dict):
        if not result.get("has_errors"):
            self.console.print(
                "  ✅ [green]{}[/green]".format(
                    result.get("encouragement", "Great French!")
                )
            )
            return

        lines = ["💬 **{}**\n".format(result.get("encouragement", ""))]
        if result.get("corrected"):
            lines.append("✏️  **Corrected:** {}\n".format(result["corrected"]))

        for err in result.get("errors", []):
            line = "- **{}**: `{}` → `{}` — {}".format(
                err["type"].replace("_", " ").title(),
                err["original"],
                err["correction"],
                err["explanation"],
            )
            if err.get("phonetic_hint"):
                line += " *(pronunciation: {})*".format(err["phonetic_hint"])
            lines.append(line)

        if result.get("pronunciation_focus"):
            lines.append("\n🔊 **Pronunciation focus:** {}".format(
                result["pronunciation_focus"]
            ))

        self.console.print(
            Panel(
                Markdown("\n".join(lines)),
                title="📝 Correction (transcript)",
                border_style="yellow",
            )
        )

    async def _end_session(self):
        self.console.print(
            "\n[bold magenta]⏳  Generating session report…[/bold magenta]")
        try:
            report = await run_evaluation_agent(
                self.oai_client, self.transcript)
            self.console.print(
                Panel(
                    Markdown(report),
                    title="📊 Session Evaluation",
                    border_style="magenta")
            )
        except Exception as e:
            self.console.print(f"[red]Evaluation Agent error: {e}[/red]")

    async def run(self):
        # ✅ Create asyncio queues INSIDE the running loop (Python 3.9
        # requirement)
        self.audio_in_queue = asyncio.Queue()
        self.audio_out_queue = asyncio.Queue()

        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "OpenAI-Beta": "realtime=v1",
        }

        self.console.print(
            Panel(
                Text(
                    "🇫🇷  French Accent Practice — Professeur Yves",
                    justify="center"),
                border_style="green",
            )
        )
        self.console.print(
            "[dim]Say [bold]'pause please'[/bold] · "
            "[bold]'let's continue'[/bold] · "
            "[bold]'end session'[/bold][/dim]\n"
        )

        async with websockets.connect(
                REALTIME_URL, additional_headers=headers) as ws:
            self.ws = ws
            await self._configure_session()
            await self._send_initial_message()

            tasks = [
                asyncio.ensure_future(self._listen_mic()),
                asyncio.ensure_future(self._send_audio()),
                asyncio.ensure_future(self._play_audio()),
                asyncio.ensure_future(self._receive_events()),
                asyncio.ensure_future(self._keyboard_control()),
            ]
            try:
                await asyncio.gather(*tasks)
            except Exception:
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise

        self.console.print("\n[bold green]👋  Au revoir ![/bold green]")
        self.pya.terminate()


if __name__ == "__main__":
    try:
        asyncio.run(FrenchTutorSession().run())
    except KeyboardInterrupt:
        print("\nSession interrupted.")
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
