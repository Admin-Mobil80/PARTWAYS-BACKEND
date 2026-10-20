// Voice providers. Audio passes through only for the live conversation; nothing
// here writes audio to storage. Without provider keys the browser's own speech
// recognition and synthesis are used.
import { route, fail } from '../lib/http.js';
import { store } from '../lib/data.js';

const VOICES = [
  { id: 'calm', label: 'Calm', description: 'Even, unhurried delivery', eleven: () => process.env.ELEVENLABS_VOICE_CALM || '21m00Tcm4TlvDq8ikWAM' },
  { id: 'clear', label: 'Clear', description: 'Crisp and straightforward', eleven: () => process.env.ELEVENLABS_VOICE_CLEAR || 'XB0fDUnXU5powFXDhCwa' },
  { id: 'low', label: 'Low and steady', description: 'Lower pitch, steady pace', eleven: () => process.env.ELEVENLABS_VOICE_LOW || 'pNInz6obpgDQGcFmaJgB' },
];

export function voiceInfo() {
  return {
    stt: process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'browser',
    tts: process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'browser',
    voices: VOICES.map(({ id, label, description }) => ({ id, label, description })),
    retention: {
      stt: process.env.DEEPGRAM_API_KEY ? 'Deepgram streaming with model-improvement opt-out (mip_opt_out). Provider-side retention terms must be confirmed for production.' : 'Browser speech recognition. In Chrome this sends audio to the browser vendor’s speech service, whose retention PartWays does not control.',
      tts: process.env.ELEVENLABS_API_KEY ? (process.env.ELEVENLABS_ZERO_RETENTION === '1' ? 'ElevenLabs with zero-retention mode requested.' : 'ElevenLabs without zero-retention mode (requires an enterprise plan).') : 'Browser speech synthesis on the device.',
    },
  };
}

async function sessionFromHeaders(req, id) {
  const s = await store().get('session', id);
  if (!s || s.accessToken !== req.headers['x-session-token']) fail(403, 'Voice is only available inside an interview.');
  if (!['in_progress', 'paused', 'awaiting_review', 'draft'].includes(s.status) && s.population !== 'preview') fail(409, 'This interview is not active.');
  return s;
}

route('POST', '/api/voice/stt-token', async (req) => {
  await sessionFromHeaders(req, req.body?.sessionId);
  if (!process.env.DEEPGRAM_API_KEY) fail(404, 'Server speech recognition is not configured.');
  const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  if (!res.ok) fail(502, 'Speech recognition is unavailable right now. You can continue by typing.');
  const j = await res.json();
  return { token: j.access_token, expiresIn: j.expires_in, model: process.env.DEEPGRAM_MODEL || 'nova-3' };
});

route('POST', '/api/voice/tts', async (req) => {
  const { sessionId, text, voice } = req.body || {};
  if (sessionId !== 'sample') await sessionFromHeaders(req, sessionId);
  if (!process.env.ELEVENLABS_API_KEY) fail(404, 'Server speech is not configured.');
  const clean = String(text || '').slice(0, sessionId === 'sample' ? 300 : 1500);
  if (!clean.trim()) fail(400, 'Nothing to say.');
  const v = VOICES.find((x) => x.id === voice) || VOICES[0];
  const qs = new URLSearchParams({ output_format: 'mp3_44100_64' });
  if (process.env.ELEVENLABS_ZERO_RETENTION === '1') qs.set('enable_logging', 'false');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.eleven()}/stream?${qs}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: clean, model_id: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5' }),
  });
  if (!res.ok || !res.body) fail(502, 'The interviewer voice is unavailable right now.');
  return {
    contentType: 'audio/mpeg',
    stream: async (write) => {
      for await (const chunk of res.body) write(Buffer.from(chunk));
    },
  };
});
