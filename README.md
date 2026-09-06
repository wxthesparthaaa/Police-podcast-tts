# Police Buddy Podcast — TTS service

Turns the daily podcast script into a single OGG/Opus voice-note file
(via Azure Speech), ready to hand straight to Telegram's "Send a Voice
Message" API. Deployed as a small Render web service.

## What it does

1. Receives `POST /generate-podcast-audio` with `{ "script": "..." }`.
2. Splits the script into sentence-safe chunks (each comfortably under
   Azure's 10-minute-per-request audio cap).
3. Calls Azure Speech's TTS REST API for each chunk, requesting
   `ogg-48khz-16bit-mono-opus` output — the exact format Telegram voice
   messages need.
4. Stitches the chunks into one continuous file with ffmpeg.
5. Returns the final audio (`Content-Type: audio/ogg`) in the response body.

`GET /health` returns a simple `{ ok: true }` check — handy for pointing
UptimeRobot at, same as your other services.

## Deploying to Render

1. **Push this folder to a new GitHub repo** (e.g. `police-podcast-tts`).
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin <your new repo URL>
   git push -u origin main
   ```
2. In the Render dashboard: **New > Web Service**, connect the repo.
3. **Runtime**: Node. **Build command**: `npm install`. **Start command**: `npm start`.
4. **Instance type**: the free tier will work, but note it spins down
   after 15 minutes of inactivity — the first request of the day will be
   slow (30-60s) while it wakes up. If that's a problem, use the cheapest
   paid tier instead for an always-on instance.
5. Under **Environment**, add these variables:
   | Key | Value |
   |---|---|
   | `AZURE_SPEECH_KEY` | Key 1 from your Speech resource's "Keys and Endpoint" page |
   | `AZURE_SPEECH_REGION` | `southeastasia` |
   | `AZURE_TTS_VOICE` | `en-SG-WayneNeural` (or any other Azure neural voice — see below) |
   | `SERVICE_TOKEN` | any long random string you make up — this is a shared secret Make will send back so random internet traffic can't hit your endpoint and burn your free quota |
6. Deploy. Once live, test it:
   ```
   curl https://<your-service>.onrender.com/health
   ```
   should return `{"ok":true,...}`.

## Choosing a different voice

Default is `en-SG-WayneNeural` (Singapore English, male). Other options
worth trying: `en-SG-LunaNeural` (Singapore English, female),
`en-US-AndrewNeural`, `en-GB-RyanNeural`. Full list is in Microsoft's
"Language and voice support" docs for Azure AI Speech — just change the
`AZURE_TTS_VOICE` environment variable, no code change needed.

## Cost

Azure's Free (F0) Speech tier covers 500,000 characters/month at no
cost. A daily 8-10 minute episode is roughly 8,000-9,500 characters, so
a full month (~270,000 characters) comfortably fits inside the free
allowance.
