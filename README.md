# French AI Tutor

A static front-end for a French language tutor with **chapter-based teaching**: teachers create chapters with custom prompts and uploaded materials (PDF / Word / images); students pick a chapter and practice with the tutor.

Based on the multi-agent design of `french_tutor_3.py` and `vocabulary_agent.py`.

---

## Quick start

```bash
git clone <this-repo>
cd <this-repo>
# Serve any static server. e.g.:
python -m http.server 8000
# then open http://localhost:8000
```

On first visit you will be asked for your OpenAI API key. It is stored only
in your browser (`localStorage`), never uploaded anywhere except directly to
`api.openai.com`.

For the `french_tutor/*.py` reference programs, set the key via env var:

```bash
export OPENAI_API_KEY="sk-..."
python french_tutor/french_tutor_3.py
```

---

## Architecture

```
Browser
├── Home / Module cards
│
├── Chapter management & selection (Teacher + Student in one page, mode toggle)
│   ├── conversation-chapters.html
│   └── vocabulary-chapters.html
│         │
│         └── Reads / writes RESTful Table API:  tables/chapters
│
├── Practice — Conversation  ──►  ?chapter=ID loads chapter prompt + materials
│   ──►  OpenAI Realtime API (WebSocket)  [voice I/O]
│   ──►  OpenAI Realtime API (WebSocket)  [correction, evaluation]
│
└── Practice — Vocabulary    ──►  ?chapter=ID auto-loads first image + prompt
    ──►  OpenAI Realtime API (WebSocket)  [image analysis, correction, evaluation]
    ──►  OpenAI Realtime API (WebSocket)  [voice I/O]
```

All OpenAI calls (chat, vision, voice) go through a single WebSocket helper in
`js/openai-ws-rest.js` so there is no browser-CORS surface to worry about.
No server is required.

## API key

**No key is bundled with this repository.** On first visit the user is prompted
for their own OpenAI key, which is stored only in that browser's
`localStorage`. See `js/api-key.js`.

To reset or change the key from any page:

```js
window.changeApiKey();   // opens the prompt again
window.clearApiKey();    // wipes the stored key
```

Get a key at <https://platform.openai.com/api-keys>. You need a project or
user key with access to the Realtime API (`gpt-realtime`).

---

## Pages & Routes

| Path | Description |
|------|-------------|
| `index.html` | Home — 4 module cards |
| `conversation-chapters.html` | Conversation chapter list (Teacher: CRUD · Student: select) |
| `vocabulary-chapters.html` | Vocabulary chapter list (Teacher: CRUD · Student: select) |
| `conversation.html?chapter=<id>` | Conversation practice session for a given chapter |
| `vocabulary.html?chapter=<id>` | Vocabulary practice session for a given chapter |
| `grammar.html` | Grammar practice (unchanged, no chapters yet) |
| External | Pronunciation site — `french-vowel-master-ou-vs-u-286685297662.us-west1.run.app` |

> **Note on modes** — Teacher / Student is currently a UI toggle stored in `localStorage` under `ch_mode`. There is no authentication; once you're ready to separate the two roles formally, just remove the toggle and key the page off a login/URL instead.

---

## Chapter System

### Data Model — `chapters` table

| Field | Type | Description |
|-------|------|-------------|
| `id` | text | UUID auto-assigned |
| `module` | text | `conversation` \| `vocabulary` |
| `title` | text | Chapter title |
| `description` | text | Short summary shown to students |
| `custom_prompt` | rich_text | Appended to the main system prompt for THIS chapter |
| `materials` | array | Uploaded files (see below) |
| `order_index` | number | Sort order within a module |
| `created_at` / `updated_at` | system | auto-managed |

### Material object shape

```js
{
  name:    "lesson1.pdf",
  mime:    "application/pdf",
  size:    345678,
  kind:    "text" | "image",
  text:    "...extracted plain text..."     // for PDF / DOCX / TXT / MD
  dataUrl: "data:image/jpeg;base64,...."    // for JPG / PNG / GIF / WEBP
}
```

### Supported uploads

| Type | Upload limit | How it's stored & used |
|------|---------------|------------------------|
| **PDF** | 50 MB | `pdf.js` extracts text (up to 50 pages, 15k chars). **Original file is NOT stored** — only the extracted text. |
| **DOCX** | 50 MB | `mammoth.js` extracts raw text. **Original file is NOT stored.** |
| **TXT / MD** | 50 MB | Read directly into the prompt. **Original file is NOT stored.** |
| **JPG / PNG / GIF / WEBP / BMP** | 20 MB | **Auto-compressed in the browser** to a JPEG dataUrl: longest edge ≤ 1600 px, quality 0.85, target ≤ 1 MB. For Vocabulary, the first chapter image auto-loads as the practice image and is sent to GPT-4o Vision. |
| **DOC (legacy)** | — | **Not supported** — please save as .docx |

**Why text-only for documents?** AI only needs the words. Discarding the original file shrinks each chapter record by 90–99 % and removes the previous 1 MB ceiling on documents.

**Why compress images?** Vocabulary requires the actual pixels for GPT-4o Vision, so we keep the image but auto-shrink huge phone photos to a size the database can store comfortably.

Text extraction is capped at ~15 000 characters per file to stay within token limits.

### Teacher flow
1. Visit `conversation-chapters.html` or `vocabulary-chapters.html`
2. Make sure the mode toggle is on **Teacher**
3. Click **New Chapter** → fill title / description / custom prompt / drop files → Save
4. Edit / delete from the card actions
5. Click **Preview** to test the chapter as a student would

### Student flow
1. Visit `conversation-chapters.html` or `vocabulary-chapters.html`
2. Switch the toggle to **Student** (no CRUD actions shown)
3. Click **Start** on any chapter card → opens the practice page with `?chapter=ID`
4. The practice page loads the chapter prompt + materials and starts AI session

---

## Conversation Module (`conversation.html` + `js/conversation.js`)

Mirrors `french_tutor_3.py`.

### Behavior with chapter
- On Start Session, `loadChapterContext()` fetches the chapter
- `buildSystemPrompt()` appends `custom_prompt`, extracted PDF / DOCX text, and image-count notice to the base prompt
- The opening greeting hint mentions the chapter title so the AI focuses on it

### Agents
| Agent | API | Prompt |
|-------|-----|--------|
| Conversation Agent | Realtime WS (`gpt-realtime`) | `SYSTEM_PROMPT` + chapter context |
| Correction Agent | Realtime WS text | `CORRECTION_PROMPT` |
| Evaluation Agent | Realtime WS text | `EVAL_PROMPT` (4 sections) |

### Tutor name
**Professeur Dominique**

---

## Vocabulary Module (`vocabulary.html` + `js/vocabulary.js`)

Mirrors `vocabulary_agent.py`.

### Behavior with chapter
- `loadChapter()` fetches the chapter on page load
- If the chapter has an image material, it's **auto-loaded** as `S.imageData` (student skips upload)
- `buildPrompt()` appends `custom_prompt` + extracted text from non-image materials

### Agents
| Agent | API | Prompt |
|-------|-----|--------|
| Image Analysis Agent | Realtime WS (multimodal) | `IMAGE_PROMPT` |
| Conversation Agent | Realtime WS (`gpt-realtime`) | `buildPrompt()` + chapter context |
| Correction Agent | Realtime WS text | `CORRECTION_PROMPT` |
| Evaluation Agent | Realtime WS text | `EVAL_PROMPT` |

---

## File Structure

```
index.html
conversation-chapters.html        ← new (Teacher + Student in one)
vocabulary-chapters.html          ← new
conversation.html                 ← unchanged shell, now reads ?chapter=ID
vocabulary.html                   ← unchanged shell, now reads ?chapter=ID
grammar.html                      ← unchanged
css/
  style.css                       — global theme + navbar
  chapters.css                    ← new — chapter pages, modal, dropzone
  conversation.css
  vocabulary.css
  vocab2.css                      — shared practice-page layout
js/
  openai-ws-rest.js               — unified OpenAI WebSocket helper
  chapters.js                     — chapter CRUD logic
  file-extract.js                 — PDF / DOCX / image extraction
  conversation.js                 — conversation module
  vocabulary.js                   — vocabulary module
  grammar.js                      — grammar module
french_tutor/
  french_tutor_3.py               — original Python reference
  vocabulary_agent.py             — original Python reference
  grammar_agent_5.py              — original Python reference
```

---

## Tech Notes

- **Realtime model**: `gpt-realtime` (GA, 2025-08 schema — `session.type: 'realtime'`, `output_modalities`, nested `audio.input` / `audio.output`)
- **Voice**: `shimmer`
- **PDF extraction**: `pdfjs-dist@3.11.174` via jsDelivr, worker pinned to same version
- **DOCX extraction**: `mammoth@1.6.0` browser bundle via jsDelivr
- **Image compression**: Canvas API; iterative quality reduction from 0.85 down to 0.45 to hit ≤ 1 MB; final dimension shrink if still too large
- **Max upload size**: 50 MB for text-bearing docs · 20 MB for images
- **Max text per file**: 15 000 chars (truncated with `…[truncated]` marker)
- **PDF page cap**: 50 pages
- **Image storage**: compressed JPEG base64 dataUrl (≤ 1 MB)
- **Mode toggle persistence**: `localStorage.ch_mode` (`teacher` | `student`)

---

## What's Not Yet Implemented

- **Hard role separation** — Teacher / Student is still a UI toggle. Next iteration: separate URLs + simple auth.
- **Grammar chapters** — Grammar module still uses its own hard-coded flow.
- **Material re-ordering** — Files appear in upload order; no drag-to-reorder yet.
- **Chapter cloning / templates** — Teachers must build each chapter manually.
- **Session history persistence** — Sessions still go to a local download, not saved per student.

---

## Recommended Next Steps

1. **Split Teacher / Student into separate pages** behind a simple password gate (e.g. `chapters/teacher-conversation.html` + `chapters/student-conversation.html`).
2. Extend chapter system to **Grammar** with the same pattern.
3. Add **per-chapter session logs** stored in a `sessions` table so teachers can review student attempts.
4. Add **drag-to-reorder** for chapters and materials.
5. Replace 1 MB / base64 storage with a proper file URL field once a CDN / storage bucket is available.
