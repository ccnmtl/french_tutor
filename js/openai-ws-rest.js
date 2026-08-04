/**
 * openai-ws-rest.js
 * ─────────────────────────────────────────────────────────────
 * Unified helper that performs OpenAI text / vision inference
 * over the Realtime WebSocket API (wss://api.openai.com/v1/realtime).
 *
 * WHY:  OpenAI's HTTPS REST endpoints (api.openai.com/v1/chat/completions)
 *       reject browser-origin requests via CORS when called with a
 *       project key (`sk-proj-…`). WebSocket connections are NOT subject
 *       to CORS, so we route all one-shot inference through the
 *       Realtime API instead.
 *
 * EXPORTS (on window.OpenAIWS):
 *   - chat({ apiKey, model, messages, temperature, maxTokens })
 *       → Promise<string>  raw text response
 *   - chatJSON({ apiKey, model, messages, temperature, maxTokens })
 *       → Promise<object>  parsed JSON (strips ```json fences)
 *
 * MESSAGES format (OpenAI Chat Completions compatible):
 *   [
 *     { role: 'system', content: 'You are…' },
 *     { role: 'user',   content: 'Hello' },
 *     // OR multimodal:
 *     { role: 'user', content: [
 *         { type:'text', text:'Describe this image' },
 *         { type:'image_url', image_url:{ url:'data:image/jpeg;base64,…' } }
 *     ]}
 *   ]
 *
 * Internally we open a short-lived ws to the Realtime API,
 * send a session.update with text-only modalities, append the messages
 * as conversation items, fire response.create, accumulate response
 * text deltas, then close.
 */
(function () {
  'use strict';

  const REALTIME_URL_BASE = 'wss://api.openai.com/v1/realtime';
  const DEFAULT_MODEL     = 'gpt-realtime';
  const REQUEST_TIMEOUT   = 60_000;   // 60 s hard timeout per request

  /* ─── Convert chat-completions message → realtime conversation.item.create ─── */
  function toRealtimeItems(messages) {
    // Realtime API distinguishes by role. We collect all "system" content
    // into a single instructions string (passed via session.update), then
    // emit user / assistant items individually.
    let systemInstructions = '';
    const items = [];

    for (const m of messages) {
      if (m.role === 'system') {
        const t = typeof m.content === 'string'
          ? m.content
          : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        systemInstructions += (systemInstructions ? '\n\n' : '') + t;
        continue;
      }

      // Build content array compatible with Realtime API
      const content = [];

      if (typeof m.content === 'string') {
        content.push({
          type: m.role === 'assistant' ? 'text' : 'input_text',
          text: m.content
        });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text' || part.type === 'input_text') {
            content.push({
              type: m.role === 'assistant' ? 'text' : 'input_text',
              text: part.text || ''
            });
          } else if (part.type === 'image_url') {
            // Realtime API expects input_image with image_url (data URL OK)
            const url = (part.image_url && part.image_url.url) || part.image_url || '';
            content.push({ type: 'input_image', image_url: url });
          }
        }
      }

      items.push({
        type: 'message',
        role: m.role,                  // 'user' or 'assistant'
        content
      });
    }

    return { systemInstructions, items };
  }

  /* ─── Core request ─── */
  function chat(opts) {
    return new Promise((resolve, reject) => {
      const {
        apiKey,
        model       = DEFAULT_MODEL,
        messages    = [],
        temperature = 0.6,
        maxTokens   = 1500
      } = opts || {};

      if (!apiKey) return reject(new Error('Missing apiKey'));
      if (!messages.length) return reject(new Error('Empty messages'));

      const url  = `${REALTIME_URL_BASE}?model=${encodeURIComponent(model)}`;
      const subs = ['realtime', `openai-insecure-api-key.${apiKey}`];

      let ws;
      try {
        ws = new WebSocket(url, subs);
      } catch (e) {
        return reject(new Error('WebSocket constructor failed: ' + e.message));
      }

      const { systemInstructions, items } = toRealtimeItems(messages);
      let accText = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error('OpenAIWS.chat: request timed out after ' + REQUEST_TIMEOUT + 'ms'));
        }
      }, REQUEST_TIMEOUT);

      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (err) reject(err); else resolve(val);
      };

      ws.onopen = () => {
        // 1) Configure session — text only, no audio, with system instructions
        //    GA Realtime API requires session.type to be specified.
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model,
            output_modalities: ['text'],
            instructions: systemInstructions || 'You are a helpful assistant.',
            max_output_tokens: maxTokens
          }
        }));

        // 2) Append each prior message as a conversation item
        for (const item of items) {
          ws.send(JSON.stringify({ type: 'conversation.item.create', item }));
        }

        // 3) Ask for a response (GA shape: output_modalities)
        ws.send(JSON.stringify({
          type: 'response.create',
          response: { output_modalities: ['text'] }
        }));
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); }
        catch { return; }

        switch (msg.type) {
          case 'response.text.delta':
            if (msg.delta) accText += msg.delta;
            break;

          case 'response.output_text.delta':
            if (msg.delta) accText += msg.delta;
            break;

          // Some server builds use response.content_part.delta for text
          case 'response.content_part.added':
            // ignore — wait for deltas
            break;

          case 'response.done':
          case 'response.completed': {
            // Pull final text if deltas didn't capture it (fallback)
            if (!accText && msg.response && Array.isArray(msg.response.output)) {
              for (const out of msg.response.output) {
                if (out.content) {
                  for (const c of out.content) {
                    if (c.type === 'text' && c.text) accText += c.text;
                    if (c.type === 'output_text' && c.text) accText += c.text;
                  }
                }
              }
            }
            done(null, accText);
            break;
          }

          case 'error': {
            const em = (msg.error && (msg.error.message || msg.error.code)) || 'Unknown OpenAI error';
            done(new Error('OpenAI: ' + em));
            break;
          }

          default:
            // Many other event types come through — ignore
            break;
        }
      };

      ws.onerror = (e) => {
        console.error('[OpenAIWS] ws error', e);
        // Don't reject here — onclose will follow with a real code
      };

      ws.onclose = (ev) => {
        if (!settled) {
          done(new Error(`OpenAIWS: socket closed (${ev.code}) ${ev.reason || ''}`));
        }
      };
    });
  }

  function clampTemp(t) {
    // Realtime API requires temperature in [0.6, 1.2]
    if (typeof t !== 'number' || isNaN(t)) return 0.8;
    if (t < 0.6) return 0.6;
    if (t > 1.2) return 1.2;
    return t;
  }

  function stripJsonFences(raw) {
    return String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }

  async function chatJSON(opts) {
    const raw  = await chat(opts);
    const text = stripJsonFences(raw);
    try {
      return JSON.parse(text);
    } catch (e) {
      // Try to find the first {...} block
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch {}
      }
      throw new Error('OpenAIWS.chatJSON: invalid JSON in response — ' + text.slice(0, 200));
    }
  }

  window.OpenAIWS = { chat, chatJSON };
})();
