// Language model access: OpenAI (Responses API). Without OPENAI_API_KEY the app
// runs in a clearly labelled offline developer mode with rule-based fallbacks.
import OpenAI from 'openai';

export const DEFAULT_MODEL = 'gpt-6.1-sol';

let cached, cachedKey;

export function llmInfo() {
  const provider = process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'offline');
  const live = provider === 'openai' && !!process.env.OPENAI_API_KEY;
  return { provider: live ? 'openai' : 'offline', live, model: process.env.LLM_MODEL || DEFAULT_MODEL };
}

// Rebuilt if the key changes (keys are re-read from Secrets Manager every few minutes).
function client() {
  if (!cached || cachedKey !== process.env.OPENAI_API_KEY) {
    cachedKey = process.env.OPENAI_API_KEY;
    cached = new OpenAI({ apiKey: cachedKey });
  }
  return cached;
}

export class RefusalError extends Error {}

// gpt-6.1-sol is a reasoning model: its output budget also covers reasoning
// tokens, so the visible answer gets headroom above what the caller asked for.
const REASONING_HEADROOM = 8000;

// Small, frequent jobs (live interview progress tracking) use a cheaper model.
export const fastModel = () => process.env.FAST_MODEL || 'gpt-6-luna';

function params({ system, messages, model, effort = 'medium', maxTokens = 16000, format }) {
  return {
    model: model || llmInfo().model,
    // Plain text; blocks of { text } are joined so callers cannot send a shape OpenAI rejects.
    instructions: Array.isArray(system) ? system.map((b) => (typeof b === 'string' ? b : b.text)).join('\n\n') : system,
    input: messages.map(({ role, content }) => ({ role, content })),
    reasoning: { effort },
    max_output_tokens: maxTokens + REASONING_HEADROOM,
    store: false,
    ...(format ? { text: { format } } : {}),
  };
}

// Runs one streamed response, passing text deltas to onText; resolves with the
// full text. Refusals and cut-off answers are errors.
async function run(p, onText) {
  const stream = await client().responses.create({ ...p, stream: true });
  let text = '', final = null;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      text += event.delta;
      onText?.(event.delta);
    } else if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') {
      throw new RefusalError('The model declined this request.');
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      final = event.response;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(event.response?.error?.message || event.message || 'The model request failed.');
    }
  }
  if (final?.status === 'incomplete') {
    throw new Error(final.incomplete_details?.reason === 'max_output_tokens' ? 'Response was cut off before completion.' : 'The model stopped before finishing.');
  }
  return text;
}

// Streams text deltas to onText and resolves with the full text.
export function streamText(opts, onText) {
  return run(params(opts), onText);
}

// Returns parsed JSON constrained to the given JSON schema.
export async function generateJson({ system, messages, schema, strict = false, model, effort = 'medium', maxTokens = 16000 }) {
  const text = await run(params({
    system, messages, model, effort, maxTokens,
    // Not strict by default: strict mode would require every field and forbid
    // optional ones, which the summary and plan schemas use.
    format: { type: 'json_schema', name: 'result', schema, strict },
  }));
  return JSON.parse(text);
}

// --- Live voice: OpenAI Realtime ---------------------------------------------------
// The browser connects to the speech-to-speech model directly over WebRTC with a
// short-lived key minted here, so the real API key never reaches the browser.
export const realtimeModel = () => process.env.REALTIME_MODEL || 'gpt-realtime-2.1';
export const realtimeLive = () => llmInfo().live && process.env.REALTIME !== 'off';
const REALTIME_VOICES = { calm: 'marin', clear: 'coral', low: 'cedar' };

export async function createRealtimeKey({ instructions, voice, language }) {
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      // Only long enough to connect; the conversation itself can run longer.
      expires_after: { anchor: 'created_at', seconds: 300 },
      session: {
        type: 'realtime',
        model: realtimeModel(),
        instructions,
        audio: {
          input: {
            transcription: { model: process.env.REALTIME_TRANSCRIBE_MODEL || 'gpt-transcribe', ...(language ? { language } : {}) },
            turn_detection: { type: 'semantic_vad' },
          },
          output: { voice: REALTIME_VOICES[voice] || REALTIME_VOICES.calm },
        },
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.value) throw new Error(data.error?.message || `Realtime key request failed (${res.status})`);
  return { key: data.value, expiresAt: data.expires_at || null, model: realtimeModel() };
}

