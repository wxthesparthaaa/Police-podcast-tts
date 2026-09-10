// Police Buddy Podcast — TTS + audio-merge microservice
//
// Takes a plain-text script (the "podcast_script" field from the Make data
// store), splits it into Azure-safe chunks, calls Azure Speech's
// text-to-speech REST API for each chunk (requesting OGG/Opus directly —
// the exact format Telegram's voice-message player needs), stitches the
// chunks into one continuous audio file with ffmpeg, and returns that file.
//
// Make's scenario POSTs the script text here and gets back a JSON
// { "url": "..." } pointing at the generated audio; Telegram's "Send a
// Voice Message" module then fetches that URL directly (its "HTTP URL"
// send option) rather than Make trying to relay raw binary bytes through
// its own buffer type system — the latter turned out to be unreliable to
// wire up via a hand-built scenario blueprint.

const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
// Render terminates TLS at its edge and forwards plain HTTP internally with
// an X-Forwarded-Proto header — trust it so req.protocol reports "https"
// correctly when we build the audio URL below.
app.set('trust proxy', true);

// In-memory store for generated audio, keyed by job ID. A finished podcast
// is fetched by Telegram (or by you, for testing) within seconds to a
// couple of minutes of being generated, so this short-lived, unguessable-ID
// approach is simpler than dealing with persistent storage — entries are
// deleted automatically after AUDIO_TTL_MS.
const audioStore = new Map();
const AUDIO_TTL_MS = 20 * 60 * 1000; // 20 minutes
// Accept either a JSON body ({"script": "..."}) or a plain-text body (the
// script itself, with Content-Type: text/plain) — Make's HTTP module can
// send raw text directly without needing to hand-build escaped JSON, so
// that's the simpler path from Make's side. Both are supported here.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.text({ type: '*/*', limit: '2mb' }));

// ---- Configuration (set these as environment variables on Render) ----
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'southeastasia';
const AZURE_TTS_VOICE = process.env.AZURE_TTS_VOICE || 'en-SG-WayneNeural';
// Shared secret so random internet traffic can't hit this endpoint and burn
// your Azure free-tier quota. Make will send this back as a header.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN;

// Default speaking-rate multiplier applied to every generated podcast unless
// the caller overrides it with a "speed" field. Azure's SSML <prosody rate>
// attribute accepts a plain multiplier like "1.5" (1.5x the voice's default
// pace), a relative percentage like "+50%", or a named value like "fast".
// Override the default via the TTS_DEFAULT_SPEED env var on Render without
// touching code.
const DEFAULT_SPEED = process.env.TTS_DEFAULT_SPEED || '1.5';

// Keep each Azure request comfortably under Azure's hard 10-minute-per-request
// audio cap (which truncates silently if exceeded, no error). ~4000
// characters is roughly 4-5 minutes of narration at a natural pace, leaving
// a wide safety margin.
const MAX_CHARS_PER_CHUNK = 4000;

const AZURE_TTS_ENDPOINT = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

function escapeSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Only allow a safe, narrow shape for the rate attribute before it gets
// embedded into the SSML XML — a plain number/decimal (multiplier, e.g.
// "1.5"), an optionally-signed percentage (e.g. "+50%", "-20%"), or one of
// Azure's named rate keywords. Anything else falls back to DEFAULT_SPEED,
// so a bad or malicious "speed" field can't inject SSML markup.
const NAMED_RATES = new Set(['x-slow', 'slow', 'medium', 'fast', 'x-fast', 'default']);
function sanitizeRate(input) {
  const value = String(input == null ? '' : input).trim();
  if (!value) return DEFAULT_SPEED;
  if (NAMED_RATES.has(value.toLowerCase())) return value.toLowerCase();
  if (/^[+-]?\d+(\.\d+)?%?$/.test(value)) return value;
  return DEFAULT_SPEED;
}

// Greedy sentence-boundary chunking so we never cut a sentence in half
// between two Azure requests (which would produce an awkward mid-sentence
// pause at the seam once the audio is stitched back together).
function chunkScript(script, maxChars) {
  const sentences = script
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [script];

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim().length > 0) chunks.push(current.trim());

  return chunks;
}

async function synthesizeChunk(text, rate) {
  const ssml = `<speak version='1.0' xml:lang='en-US'>` +
    `<voice xml:lang='en-US' name='${AZURE_TTS_VOICE}'>` +
    `<prosody rate='${rate}'>${escapeSsml(text)}</prosody>` +
    `</voice>` +
    `</speak>`;

  const response = await axios.post(AZURE_TTS_ENDPOINT, ssml, {
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      // 48kHz mono Opus in an Ogg container — this is the exact format
      // Telegram's sendVoice API expects for a native voice-message bubble.
      'X-Microsoft-OutputFormat': 'ogg-48khz-16bit-mono-opus',
      'User-Agent': 'PoliceBuddyPodcast/1.0',
    },
    responseType: 'arraybuffer',
    timeout: 60_000,
  });

  return Buffer.from(response.data);
}

async function concatOggFiles(filePaths, outputPath) {
  const listPath = outputPath + '.list.txt';
  const listContent = filePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listPath, listContent);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });

  await fsp.unlink(listPath).catch(() => {});
}

app.get('/health', (req, res) => {
  res.json({ ok: true, region: AZURE_SPEECH_REGION, voice: AZURE_TTS_VOICE, defaultSpeed: DEFAULT_SPEED });
});

app.post('/generate-podcast-audio', async (req, res) => {
  // --- auth ---
  if (SERVICE_TOKEN && req.headers['x-service-token'] !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!AZURE_SPEECH_KEY) {
    return res.status(500).json({ error: 'AZURE_SPEECH_KEY is not configured on the server' });
  }

  const rawScript = typeof req.body === 'string' ? req.body : (req.body && req.body.script);
  const script = (rawScript || '').trim();
  if (!script) {
    return res.status(400).json({ error: 'Missing script — send it as the raw request body (text/plain) or as {"script": "..."} (application/json)' });
  }

  // Optional per-request override of the speaking rate, e.g. "speed": "1.5"
  // or "speed": "+50%". Falls back to DEFAULT_SPEED (1.5x) when omitted,
  // missing, or not in a recognized shape.
  const rate = sanitizeRate(req.body && typeof req.body === 'object' ? req.body.speed : undefined);

  const jobId = crypto.randomBytes(6).toString('hex');
  const tmpDir = os.tmpdir();
  const chunkPaths = [];
  const finalPath = path.join(tmpDir, `podcast-${jobId}-final.ogg`);

  try {
    const chunks = chunkScript(script, MAX_CHARS_PER_CHUNK);
    console.log(`[${jobId}] script length=${script.length} chars, split into ${chunks.length} chunk(s), rate=${rate}`);

    for (let i = 0; i < chunks.length; i++) {
      const audioBuffer = await synthesizeChunk(chunks[i], rate);
      const chunkPath = path.join(tmpDir, `podcast-${jobId}-part${i}.ogg`);
      await fsp.writeFile(chunkPath, audioBuffer);
      chunkPaths.push(chunkPath);
      console.log(`[${jobId}] chunk ${i + 1}/${chunks.length} synthesized (${audioBuffer.length} bytes)`);
    }

    if (chunkPaths.length === 1) {
      await fsp.copyFile(chunkPaths[0], finalPath);
    } else {
      await concatOggFiles(chunkPaths, finalPath);
    }

    const finalBuffer = await fsp.readFile(finalPath);
    console.log(`[${jobId}] done — final audio ${finalBuffer.length} bytes`);

    if (req.query.raw === '1') {
      // Manual-testing shortcut: return the audio bytes directly instead of
      // a URL, e.g. for `curl ... | mpv -` style checks.
      res.set('Content-Type', 'audio/ogg');
      res.set('Content-Disposition', 'inline; filename="police-buddy-podcast.ogg"');
      return res.send(finalBuffer);
    }

    audioStore.set(jobId, finalBuffer);
    setTimeout(() => audioStore.delete(jobId), AUDIO_TTL_MS).unref();

    const audioUrl = `${req.protocol}://${req.get('host')}/audio/${jobId}.ogg`;
    res.json({ url: audioUrl, bytes: finalBuffer.length, rate });
  } catch (err) {
    console.error(`[${jobId}] failed:`, err.response?.data?.toString?.() || err.message);
    res.status(502).json({ error: 'TTS generation failed', detail: err.message });
  } finally {
    // Clean up temp files regardless of success/failure.
    for (const p of [...chunkPaths, finalPath]) {
      fs.promises.unlink(p).catch(() => {});
    }
  }
});

app.get('/audio/:id.ogg', (req, res) => {
  const buffer = audioStore.get(req.params.id);
  if (!buffer) {
    return res.status(404).json({ error: 'Not found — audio may have already expired (20 minute lifetime) or the job ID is wrong' });
  }
  res.set('Content-Type', 'audio/ogg');
  res.set('Content-Length', buffer.length);
  res.send(buffer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Police Buddy podcast TTS service listening on port ${PORT}`);
  console.log(`Using Azure region: ${AZURE_SPEECH_REGION}, voice: ${AZURE_TTS_VOICE}, default speed: ${DEFAULT_SPEED}`);
});
