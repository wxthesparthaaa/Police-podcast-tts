// Police Buddy Podcast — TTS + audio-merge microservice
//
// Takes a plain-text script (the "podcast_script" field from the Make data
// store), splits it into Azure-safe chunks, calls Azure Speech's
// text-to-speech REST API for each chunk (requesting OGG/Opus directly —
// the exact format Telegram's voice-message player needs), stitches the
// chunks into one continuous audio file with ffmpeg, and returns that file.
//
// Make's scenario just needs to: POST the script text here, and feed the
// binary response straight into Telegram's "Send a Voice Message" module.

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
app.use(express.json({ limit: '2mb' }));

// ---- Configuration (set these as environment variables on Render) ----
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'southeastasia';
const AZURE_TTS_VOICE = process.env.AZURE_TTS_VOICE || 'en-SG-WayneNeural';
// Shared secret so random internet traffic can't hit this endpoint and burn
// your Azure free-tier quota. Make will send this back as a header.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN;

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

async function synthesizeChunk(text) {
  const ssml = `<speak version='1.0' xml:lang='en-US'>` +
    `<voice xml:lang='en-US' name='${AZURE_TTS_VOICE}'>${escapeSsml(text)}</voice>` +
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
  res.json({ ok: true, region: AZURE_SPEECH_REGION, voice: AZURE_TTS_VOICE });
});

app.post('/generate-podcast-audio', async (req, res) => {
  // --- auth ---
  if (SERVICE_TOKEN && req.headers['x-service-token'] !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!AZURE_SPEECH_KEY) {
    return res.status(500).json({ error: 'AZURE_SPEECH_KEY is not configured on the server' });
  }

  const script = (req.body && req.body.script || '').trim();
  if (!script) {
    return res.status(400).json({ error: 'Missing "script" in request body' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  const tmpDir = os.tmpdir();
  const chunkPaths = [];
  const finalPath = path.join(tmpDir, `podcast-${jobId}-final.ogg`);

  try {
    const chunks = chunkScript(script, MAX_CHARS_PER_CHUNK);
    console.log(`[${jobId}] script length=${script.length} chars, split into ${chunks.length} chunk(s)`);

    for (let i = 0; i < chunks.length; i++) {
      const audioBuffer = await synthesizeChunk(chunks[i]);
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

    res.set('Content-Type', 'audio/ogg');
    res.set('Content-Disposition', 'inline; filename="police-buddy-podcast.ogg"');
    res.send(finalBuffer);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Police Buddy podcast TTS service listening on port ${PORT}`);
  console.log(`Using Azure region: ${AZURE_SPEECH_REGION}, voice: ${AZURE_TTS_VOICE}`);
});
