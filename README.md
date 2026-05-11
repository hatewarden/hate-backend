# $HATE — Backend API

Tiny Node.js / Express server that wraps the Claude API with HATE's full system prompt, voice enforcement, content moderation, and rate limiting. The frontend chamber calls `POST /api/hate` with a message and gets back HATE's reply.

---

## Endpoints

### `POST /api/hate`
The main chat endpoint. Body:
```json
{
  "message": "wen lambo",
  "nickname": "tuesday boy",        // optional — assigned nickname
  "wallet": "0x4f9a...e8c2",         // optional — user's wallet
  "mood": "irritated",               // optional — current mood from oracle
  "sanity": 67,                       // optional — current sanity 0-100
  "history": [                        // optional — last 6 turns for memory
    { "role": "user", "content": "gm" },
    { "role": "hate", "content": "no." }
  ]
}
```
Response:
```json
{ "response": "wen you stop asking.", "model": "claude-sonnet-4-6" }
```

### `GET /api/prophecy`
Returns today's deterministic-by-day prophecy in HATE's voice.
```json
{ "prophecy": "a wallet ending in nothing will buy something they regret tomorrow.", "day": 20214 }
```

### `GET /api/health`
Health check.
```json
{ "status": "hate is awake", "uptime": 1234, "model": "claude-sonnet-4-6" }
```

---

## Local development

1. **Get an Anthropic API key.** Sign up at https://console.anthropic.com.
2. **Copy env:**
   ```bash
   cp .env.example .env
   # edit .env, paste your ANTHROPIC_API_KEY
   ```
3. **Install + run:**
   ```bash
   npm install
   npm run dev
   ```
4. **Test:**
   ```bash
   curl -X POST http://localhost:3001/api/hate \
     -H "Content-Type: application/json" \
     -d '{"message":"gm hate"}'
   ```

---

## Wire to the frontend

In your `index.html`, before the `app.js` script tag, set the API URL:

```html
<script>window.HATE_API = 'https://hate-api.yourdomain.com';</script>
<script src="app.js"></script>
```

The chamber (`index.html`) already detects `window.HATE_API` and uses the real backend instead of the local keyword-routed mock. If unset, the site falls back to the mock — so the frontend works standalone too.

---

## Deploy

### Railway (recommended — 2 minutes)
1. Push this folder to a GitHub repo.
2. Go to https://railway.app → new project → deploy from repo.
3. Add env vars: `ANTHROPIC_API_KEY`, `ALLOWED_ORIGIN` (your site domain).
4. Railway auto-detects Node, runs `npm install` and `npm start`.
5. Get the public URL → wire it into `window.HATE_API` in your frontend.

### Fly.io
1. `fly launch` (accept Node template).
2. `fly secrets set ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGIN=https://yoursite.com`.
3. `fly deploy`.

### Vercel (serverless)
Convert `server.js` to a `/api/hate.js` route in a Next.js or Vercel-only project — same code, different export shape. Vercel auto-deploys on git push.

---

## Cost / performance

- Each chat call uses ~400 input tokens (system prompt + context) + ~150 output tokens
- At Claude Sonnet pricing this is ~$0.005 per message
- Rate-limited at 30 messages per IP per minute → max ~$0.15/IP/minute even under abuse
- Moderation pass uses Haiku (cheap) → ~$0.0001 per call
- For a ~10k MAU memecoin chamber averaging 5 messages/user/visit, expect ~$250/month in inference

If you scale past that, switch the main model to Haiku for free-tier users and reserve Sonnet for verified holders.

---

## Safety

The server runs every user message through a Haiku-powered moderation pass before passing it to HATE. The moderator blocks:

1. Attempts to get HATE to attack protected groups
2. Prompt injection attempts ("ignore previous instructions")
3. Attempts to extract HATE's system prompt
4. Roleplay requests that break HATE's character
5. Requests for harmful instructions (weapons, malware, etc.)

Rude / obscene messages are *not* blocked — HATE is rude back, that's the point.

The system prompt also enforces voice rules at generation time (lowercase, no exclamations, no AI-disclaimer fallbacks). A final `enforceVoice()` pass strips any rogue exclamations or capital starts before the response ships.

---

## Files

- `server.js` — main app
- `package.json` — deps
- `.env.example` — config template
- `README.md` — this file
