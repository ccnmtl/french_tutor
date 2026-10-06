# -*- coding: utf-8 -*-
"""
French Vocabulary Recognition Agent
Multi-Agent Architecture:
  - Image Analysis Agent : analyzes uploaded image, extracts objects &
    positions (GPT-4o Vision)
  - Conversation Agent : drives vocabulary practice via voice (OpenAI
    Realtime API)
  - Correction Agent : detects grammar/article/vocabulary errors,
    gives feedback
  - Evaluation Agent      : end-of-session performance summary

Transport  : OpenAI Realtime API (WebSocket)
Audio I/O  : pyaudio  (mic → PCM16 24 kHz → API, API → PCM16 24 kHz → speaker)
Vision     : GPT-4o  (image analysis before session)
Usage      : python vocabulary_agent.py [path/to/image.jpg]
             or run without argument and enter image path when prompted
"""

import asyncio
import base64
import json
import os
import sys
import pathlib
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
#  Set OPENAI_API_KEY in a .env file or as an environment variable
# ──────────────────────────────────────────────
REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
VISION_MODEL = "gpt-4o"
CORRECTION_MODEL = "gpt-4o"
EVALUATION_MODEL = "gpt-4o"

# ──────────────────────────────────────────────
#  Image Analysis Agent prompt
# ──────────────────────────────────────────────
IMAGE_ANALYSIS_PROMPT = """
Analyze this image carefully for a French vocabulary teaching exercise.
Return ONLY a JSON object (no markdown fences) with this exact schema:

{
  "scene_description_fr": "<brief scene description in French, 1-2 sentences>",
  "objects": [
    {
      "name_fr": "<French name of object>",
      "article_def": "<definite article: le/la/les>",
      "article_indef": "<indefinite article: un/une/des>",
      "name_en": "<English name>",
      "position": "<spatial position in French, e.g. 'à gauche', 'au
      centre', 'sur la table', 'près de la fenêtre'>",
      "color_fr": "<color in French if clearly visible, or empty string>"
    }
  ],
  "spatial_description_fr": "<description of how objects relate to
  each other spatially, in French, 2-3 sentences>",
  "suggested_questions_fr": [
    "<question 1 about objects in the image, in French>",
    "<question 2>",
    "<question 3>",
    "<question 4>",
    "<question 5>"
  ]
}

Identify ALL clearly visible objects. For suggested questions, use
vocabulary identification patterns like:
- "Qu'est-ce qu'il y a sur la table ?"
- "Qu'est-ce que vous voyez à gauche ?"
- "De quelle couleur est [object] ?"
- "Où se trouve [object] ?"
- "Quels objets voyez-vous dans cette image ?"
- "Qu'est-ce qu'il y a à côté de [object] ?"
""".strip()

# ──────────────────────────────────────────────
#  Conversation Agent system prompt template
# ──────────────────────────────────────────────
CONVERSATION_SYSTEM_PROMPT_TEMPLATE = """
Tu es un professeur de français qui fait pratiquer le vocabulaire à un élève.
L'élève regarde une image dont tu connais le contenu exact.

**CONTENU DE L'IMAGE:**
Scène : {scene_description_fr}
Objets visibles : {objects_list}
Disposition spatiale : {spatial_description_fr}

**TON RÔLE:**
- Parle UNIQUEMENT en français, tout le temps — jamais en anglais.
- Garde tes réponses COURTES : 1 à 3 phrases maximum par tour.
- Tu aides l'élève à identifier et nommer les objets en français, avec
  les bons articles.

**DÉBUT DE SESSION:**
Commence par saluer brièvement l'élève, puis décris l'image en 1
phrase et pose la première question.  Exemples de questions :
"Qu'est-ce qu'il y a sur la table, à gauche ?", "Quels objets
voyez-vous ?", "Qu'est-ce que vous voyez à droite ?"

**STRATÉGIE PÉDAGOGIQUE — RESPECTE CET ORDRE:**

1. **Si la réponse est incompréhensible ou comporte des erreurs de
grammaire graves :**
   → Demande à l'élève de répéter : "Pouvez-vous répéter, s'il vous
   plaît ?" ou "Je n'ai pas bien compris. Pouvez-vous répéter ?"

2. **Si après la répétition la réponse est toujours peu claire ou
inattendue :**
   → Propose 2 ou 3 alternatives à choisir. Exemples :
   "Est-ce que vous voyez une chaise, une table ou une lampe ?"
   "C'est le livre, le stylo ou le cahier ?"

3. **Seulement si les deux stratégies ci-dessus ont échoué :**
   → Donne la bonne réponse, puis demande immédiatement à l'élève de
   la répéter :
   "On dit 'un livre'. Pouvez-vous répéter : 'Je vois un livre' ?"

**CORRECTION DES ARTICLES ET DU VOCABULAIRE:** - Si l'élève oublie
l'article (ex : "chat" au lieu de "le chat"), corrige naturellement
dans ta réponse en modélisant la forme correcte.  - Si le vocabulaire
est bon mais l'article est faux, reconnais le mot et corrige l'article
: "Oui, c'est bien une chaise ! On dit 'une chaise', pas 'un chaise'."
- Si l'élève ne connaît pas un mot, donne-lui le mot français avec son
article avant de lui demander de l'utiliser.

**CORRECTION DE LA PRONONCIATION:** - Si la transcription suggère une
mauvaise prononciation, modèle la prononciation correcte en français :
"Attention à la prononciation : on dit '[mot correct]', avec un son
[description simple]."  - Ne dis jamais explicitement "tu as fait une
erreur" — modèle naturellement la forme correcte dans ta réponse.

**IMPOSITION DU FRANÇAIS:** - Si l'élève parle en anglais ou dans une
autre langue, réponds UNIQUEMENT en français : "S'il vous plaît,
répondez en français !" puis répète ta question.  - Ne passe jamais à
l'anglais, même pour expliquer la grammaire. Utilise toujours un
français simple.

**PROGRESSION:** - Travaille sur les {num_objects} objets de manière
systématique, en variant les types de questions.  - Après avoir
identifié un objet, pose une question complémentaire (couleur,
position, objet voisin).  - Utilise les questions suggérées suivantes
(varie-les) : {suggested_questions_formatted}

**CONTRÔLE DE SESSION:**
- Si l'élève dit "pause" ou "une pause" → accuse réception et attends.
- Si l'élève dit "continuer" ou "on continue" → reprends la session.
- Si l'élève dit "terminer" ou "fin" → dis au revoir chaleureusement
  en français, puis émets le token exact [SESSION_END].
""".strip()

# ──────────────────────────────────────────────
#  Correction Agent prompt
# ──────────────────────────────────────────────
CORRECTION_PROMPT_TEMPLATE = """
Tu es un correcteur expert en langue française, spécialisé dans
l'usage du vocabulaire et des articles.  Analyse l'énoncé suivant d'un
élève dans le cadre d'un exercice d'identification de vocabulaire.
Réponds UNIQUEMENT avec un objet JSON (sans balises markdown)
correspondant exactement à ce schéma :

{{
  "has_errors": true | false,
  "corrected": "<phrase française corrigée, ou chaîne vide si pas d'erreurs>",
  "errors": [
    {{
      "type": "article | gender_agreement | vocabulary |
      pronunciation_note | word_order | missing_word",
      "original": "<le fragment problématique>",
      "correction": "<la forme correcte>",
      "explanation": "<explication concise en anglais, 20 mots max>"
    }}
  ],
  "vocabulary_ok": true | false,
  "encouragement": "<une courte phrase d'encouragement en anglais>"
}}

Porte une attention particulière à :
- Articles manquants ou incorrects (le/la/les/un/une/des)
- Accord de genre (ex : "un table" au lieu de "une table")
- Vocabulaire correct pour les objets courants
- Ordre des mots

Énoncé de l'élève (en français) : {utterance}
""".strip()

# ──────────────────────────────────────────────
#  Evaluation Agent prompt
# ──────────────────────────────────────────────
EVALUATION_PROMPT_TEMPLATE = """
You are a French language assessor evaluating a vocabulary recognition session.
Based on the full session transcript below, write a concise
performance report in English.  Structure it as markdown with these
sections:

## Session Summary
## Vocabulary Performance 📚
## Article Usage (le/la/les/un/une) 🎯
## Pronunciation Notes 🎤
## Strengths 💪
## Areas to Improve 📝
## Recommended Practice
## Overall Score  (format: X / 10)

Transcript:
{transcript}
""".strip()


# ══════════════════════════════════════════════
#  Image Analysis Agent
# ══════════════════════════════════════════════
def analyze_image(client: OpenAI, image_path: str) -> dict:
    """
    Analyze image using GPT-4o vision and extract French vocabulary
    context.
    """

    image_path = pathlib.Path(image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    suffix = image_path.suffix.lower()
    mime_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif",
        ".webp": "image/webp"
    }
    mime_type = mime_map.get(suffix, "image/jpeg")

    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")

    resp = client.chat.completions.create(
        model=VISION_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": IMAGE_ANALYSIS_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{image_data}"},
                    },
                ],
            }
        ],
        temperature=0.2,
        max_tokens=1500,
    )

    raw = resp.choices[0].message.content.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(
            lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        if raw.startswith("json"):
            raw = raw[4:].strip()

    return json.loads(raw)


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
            lines = raw.split("\n")
            raw = "\n".join(
                lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            if raw.startswith("json"):
                raw = raw[4:].strip()
        return json.loads(raw)

    return await asyncio.to_thread(_call)


# ══════════════════════════════════════════════
#  Evaluation Agent
# ══════════════════════════════════════════════
async def run_evaluation_agent(client: OpenAI, transcript: list[dict]) -> str:
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
#  Main Vocabulary Session
# ══════════════════════════════════════════════
class VocabularySession:

    def __init__(self, image_analysis: dict):
        self.console = Console()
        self.pya = pyaudio.PyAudio()
        self.oai_client = OpenAI(api_key=OPENAI_API_KEY)
        self.image_data = image_analysis

        self.audio_in_queue = None
        self.audio_out_queue = None

        self.paused = False
        self.session_ended = False
        self.transcript = []

        self.speaking = False
        self.recording = False
        self.assistant_speaking = True   # starts True so we wait for greeting
        self.audio_chunks_recorded = 0
        self.ws = None

        # Build system prompt from image analysis
        self.system_prompt = self._build_system_prompt()

    # ── Build system prompt from image data ─────
    def _build_system_prompt(self) -> str:
        data = self.image_data
        objects = data.get("objects", [])

        # Format objects list: "le livre (à gauche), une lampe (au
        # centre), ..."
        objects_list = ", ".join(
            f"{o['article_def']} {o['name_fr']} ({o['position']})"
            for o in objects
        )

        questions = data.get("suggested_questions_fr", [])
        suggested_questions_formatted = "\n".join(f"- {q}" for q in questions)

        return CONVERSATION_SYSTEM_PROMPT_TEMPLATE.format(
            scene_description_fr=data.get("scene_description_fr", ""),
            objects_list=objects_list,
            spatial_description_fr=data.get("spatial_description_fr", ""),
            num_objects=len(objects),
            suggested_questions_formatted=suggested_questions_formatted,
        )

    # ── WebSocket send ──────────────────────────
    async def _send(self, payload: dict):
        await self.ws.send(json.dumps(payload))

    # ── Session configuration ───────────────────
    async def _configure_session(self):
        await self._send({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": self.system_prompt,
                "voice": "shimmer",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                # Whisper transcription in French
                "input_audio_transcription": {
                    "model": "whisper-1", "language": "fr"},
                # Manual push-to-talk — no auto turn detection
                "turn_detection": None,
                "temperature": 0.8,
            },
        })
        self.console.print("[bold green]✅  Session configurée[/bold green]")

    # ── Trigger initial greeting ────────────────
    async def _send_initial_message(self):
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "Bonjour ! Commencez la session maintenant.",
                }],
            },
        })
        await self._send({
            "type": "response.create",
            "response": {"modalities": ["text", "audio"]},
        })

    # ── Coroutine 1 : mic capture ───────────────
    async def _listen_mic(self):
        mic_info = self.pya.get_default_input_device_info()
        stream = self.pya.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        self.console.print("🎤  [yellow]Microphone prêt[/yellow]")

        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.05)
                continue

            data = await asyncio.to_thread(
                stream.read, CHUNK_SIZE, exception_on_overflow=False
            )

            if not self.recording:
                continue

            self.audio_chunks_recorded += 1

            samples = [
                int.from_bytes(data[i:i + 2], "little", signed=True)
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

    # ── Coroutine 2 : send audio chunks ─────────
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

    # ── Coroutine 3 : play audio output ─────────
    async def _play_audio(self):
        stream = self.pya.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            output=True,
            frames_per_buffer=CHUNK_SIZE,
        )
        while not self.session_ended:
            chunk = await self.audio_out_queue.get()
            if chunk is None:   # sentinel on session end
                break
            await asyncio.to_thread(stream.write, chunk)

        stream.stop_stream()
        stream.close()

    # ── Coroutine 4 : push-to-talk keyboard ─────
    async def _keyboard_control(self):
        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.1)
                continue

            # Wait for assistant to finish speaking
            while self.assistant_speaking and not self.session_ended:
                await asyncio.sleep(0.1)

            if self.session_ended:
                break

            # Flush stale stdin
            try:
                import termios
                termios.tcflush(sys.stdin, termios.TCIFLUSH)
            except Exception:
                pass

            self.console.print(
                "\n[bold cyan]🟢 Appuyez sur ENTRÉE pour "
                "parler...[/bold cyan]",
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
                "🔴 [bold red]Enregistrement... Appuyez sur "
                "ENTRÉE pour terminer.[/bold red]",
                end=""
            )
            try:
                await asyncio.to_thread(input)
            except EOFError:
                break

            self.recording = False

            if self.audio_chunks_recorded < 3:
                self.console.print(
                    "\n[yellow]⚠️  Trop court — réessayez.[/yellow]")
                continue

            self.console.print("\n⏳ [dim]Traitement…[/dim]")
            await self._send({"type": "input_audio_buffer.commit"})
            await self._send({
                "type": "response.create",
                "response": {"modalities": ["text", "audio"]},
            })
            self.assistant_speaking = True

    # ── Coroutine 5 : receive API events ────────
    async def _receive_events(self):
        tutor_text_buffer = []

        async for raw in self.ws:
            event = json.loads(raw)
            etype = event.get("type", "")

            # Audio delta → speaker queue
            if etype == "response.audio.delta":
                pcm = base64.b64decode(event["delta"])
                await self.audio_out_queue.put(pcm)

            # Student transcript via Whisper
            elif (
                    etype ==
                    "conversation.item.input_audio_transcription.completed"
            ):
                utterance = event.get("transcript", "").strip()
                if utterance:
                    self.console.print(
                        f"\n👤 [bold cyan]Élève:[/bold cyan] {utterance}")
                    self.transcript.append({
                        "role": "student",
                        "text": utterance
                    })

                    lower = utterance.lower()
                    if any(w in lower for w in [
                            "pause", "une pause", "arrêt"]):
                        self.paused = True
                        self.console.print(
                            "⏸️  [yellow]En pause. Dites 'continuer' "
                            "pour reprendre.[/yellow]"
                        )
                    elif (
                            any(w in lower for w in [
                                "continuer", "on continue", "reprendre"
                            ]) and self.paused
                    ):
                        self.paused = False
                        self.console.print("▶️  [green]Reprise.[/green]")

                    # Run correction in background (non-blocking)
                    asyncio.create_task(self._handle_correction(utterance))

            # Tutor audio transcript (streaming delta)
            elif etype == "response.audio_transcript.delta":
                tutor_text_buffer.append(event.get("delta", ""))

            # Tutor turn complete
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
                            title="🤖 Professeur",
                            border_style="blue",
                        )
                    )
                    if "[SESSION_END]" in tutor_text:
                        self.session_ended = True
                        await self.audio_out_queue.put(None)   # stop playback
                        await self._end_session()
                        return

                self.assistant_speaking = False

            elif etype == "error":
                self.console.print(f"[red]⚠️  API error: {event}[/red]")

    # ── Correction feedback display ──────────────
    async def _handle_correction(self, utterance: str):
        try:
            result = await run_correction_agent(self.oai_client, utterance)
        except Exception as e:
            self.console.print(f"[red]Correction Agent error: {e}[/red]")
            return

        if not result.get("has_errors"):
            self.console.print(
                "  ✅ [green]"
                f"{result.get('encouragement', 'Excellent français!')}[/green]"
            )
            return

        lines = [f"💬 **{result.get('encouragement', '')}**\n"]
        if result.get("corrected"):
            lines.append(f"✏️  **Corrigé :** {result['corrected']}\n")
        for err in result.get("errors", []):
            label = err["type"].replace("_", " ").title()
            lines.append(
                f"- **{label}** : `{err['original']}` →"
                f"`{err['correction']}` — {err['explanation']}"
            )

        self.console.print(
            Panel(
                Markdown("\n".join(lines)),
                title="📝 Correction",
                border_style="yellow",
            )
        )

    # ── End-of-session evaluation ────────────────
    async def _end_session(self):
        self.console.print(
            "\n[bold magenta]⏳  Génération du "
            "rapport de session…[/bold magenta]"
        )
        try:
            report = await run_evaluation_agent(
                self.oai_client, self.transcript)
            self.console.print(
                Panel(
                    Markdown(report),
                    title="📊 Évaluation de la Session",
                    border_style="magenta",
                )
            )
        except Exception as e:
            self.console.print(f"[red]Evaluation Agent error: {e}[/red]")

    # ── Entry point ──────────────────────────────
    async def run(self):
        self.audio_in_queue = asyncio.Queue()
        self.audio_out_queue = asyncio.Queue()

        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "OpenAI-Beta": "realtime=v1",
        }

        self.console.print(
            Panel(
                Text(
                    "🇫🇷  Agent de Vocabulaire — "
                    "Reconnaissance d'Images en Français",
                    justify="center",
                ),
                border_style="green",
            )
        )
        self.console.print(
            "[dim]Commandes : [bold]'pause'[/bold] · "
            "[bold]'continuer'[/bold] · [bold]'terminer'[/bold][/dim]\n"
        )

        # Display image context panel
        objects = self.image_data.get("objects", [])
        obj_display = "  ".join(
            f"[cyan]{o['article_def']} {o['name_fr']}[/cyan] ({o['position']})"
            for o in objects
        )
        self.console.print(
            Panel(
                "[bold]Scène :[/bold] "
                f"{self.image_data.get('scene_description_fr', '')}\n\n"
                f"[bold]Objets détectés :[/bold]\n{obj_display}",
                title="🖼️  Image analysée",
                border_style="cyan",
            )
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
                raise

        self.console.print(
            "\n[bold green]👋  Au revoir ! Bonne continuation ![/bold green]")
        self.pya.terminate()


# ══════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════
def main():
    console = Console()

    # ── Validate API key ───────────────────────
    if not OPENAI_API_KEY:
        console.print(
            "[red]❌  OPENAI_API_KEY non trouvée.[/red]\n"
            "[dim]Créez un fichier [bold].env[/bold] avec :[/dim]\n"
            "[bold yellow]OPENAI_API_KEY=sk-...[/bold yellow]"
        )
        sys.exit(1)

    # ── Get image path ─────────────────────────
    if len(sys.argv) > 1:
        image_path = sys.argv[1]
    else:
        console.print(
            Panel(
                "Bienvenue dans l'Agent de Vocabulaire Français !\n\n"
                "Cet agent analyse une image et conduit une session de\n"
                "reconnaissance de vocabulaire en français par la voix.",
                title="🇫🇷  Agent de Vocabulaire",
                border_style="green",
            )
        )
        console.print(
            "[bold cyan]🖼️  Entrez le chemin de l'image :[/bold cyan] ",
            end="")
        image_path = input().strip().strip('"').strip("'")

    if not image_path:
        console.print("[red]❌  Aucun chemin d'image fourni.[/red]")
        sys.exit(1)

    # ── Analyze image ──────────────────────────
    oai_client = OpenAI(api_key=OPENAI_API_KEY)
    console.print(
        f"\n[bold yellow]🔍  Analyse de l'image : {image_path} …[/bold yellow]")

    try:
        image_analysis = analyze_image(oai_client, image_path)
    except FileNotFoundError as e:
        console.print(f"[red]❌  {e}[/red]")
        sys.exit(1)
    except json.JSONDecodeError:
        console.print(
            "[red]❌  La réponse de l'analyse de "
            "l'image n'est pas du JSON valide.[/red]"
        )
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]❌  Échec de l'analyse de l'image : {e}[/red]")
        sys.exit(1)

    objects = image_analysis.get("objects", [])
    console.print(
        "[green]✅  Image analysée : " +
        f"{len(objects)} objet(s) détecté(s)[/green]\n")

    # ── Run vocabulary session ─────────────────
    session = VocabularySession(image_analysis)
    try:
        asyncio.run(session.run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Session interrompue.[/yellow]")
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
