/**
 * api-key.js
 * ────────────────────────────────────────────────────────────
 * Runtime API-key manager. Prompts the user for their OpenAI
 * API key on first visit, stores it in localStorage, and exposes
 * `window.getApiKey()` for the rest of the app.
 *
 * No key is ever bundled with the source. Each user must supply
 * their own key, which stays entirely in their browser.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'openai_api_key';

  function read() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; }
    catch { return ''; }
  }

  function write(k) {
    try { localStorage.setItem(STORAGE_KEY, k); } catch {}
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  function looksValid(k) {
    return typeof k === 'string' && /^sk-[A-Za-z0-9_-]{20,}$/.test(k.trim());
  }

  function promptForKey(initial) {
    const msg =
      'Enter your OpenAI API key.\n\n' +
      'It stays only in this browser (localStorage) and is never uploaded anywhere\n' +
      'except directly to api.openai.com from your machine.\n\n' +
      'Get one at: https://platform.openai.com/api-keys';
    const v = window.prompt(msg, initial || '');
    if (v === null) return '';
    return v.trim();
  }

  function ensureKey() {
    let k = read();
    while (!looksValid(k)) {
      k = promptForKey(k);
      if (!k) {
        alert('An OpenAI API key is required to use this app.');
        return '';
      }
      if (!looksValid(k)) {
        alert('That does not look like a valid OpenAI key (should start with "sk-").');
        continue;
      }
      write(k);
    }
    return k;
  }

  function changeKey() {
    const cur = read();
    const v = promptForKey(cur);
    if (!v) return;
    if (!looksValid(v)) {
      alert('That does not look like a valid OpenAI key.');
      return;
    }
    write(v);
    alert('API key updated. Reload the page to apply.');
  }

  window.getApiKey = ensureKey;
  window.clearApiKey = clear;
  window.changeApiKey = changeKey;
})();
