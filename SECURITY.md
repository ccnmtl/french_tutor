# Security notes

## API keys

- **No API key is committed to this repository.**
- The web app asks each user for their own OpenAI key on first visit and stores
  it in that browser's `localStorage` only.
- The Python reference programs in `french_tutor/` read the key from the
  `OPENAI_API_KEY` environment variable.

If you find a key in the git history, please open an issue (or a private
security advisory on GitHub) so the owner can revoke it.

## What NOT to commit

- OpenAI keys (`sk-…` / `sk-proj-…`)
- `.env` / `.env.local`
- Any file matching `*.key`, `*.pem`
- Screenshots or logs that contain a key in the URL, headers, or a request body

## Rotating a key

If a key is ever exposed:

1. Go to <https://platform.openai.com/api-keys>
2. Delete the exposed key
3. Generate a new one
4. Users of the web app just re-enter it via `window.changeApiKey()` (or clear
   `localStorage` and reload)
