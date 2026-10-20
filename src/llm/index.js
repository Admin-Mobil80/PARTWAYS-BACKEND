// Language model access. Claude via the Anthropic API or Amazon Bedrock; without
// credentials the app runs in a clearly labelled offline developer mode.
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

let cached;

export function llmInfo() {
  const provider = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'offline');
  return {
    provider,
    live: provider !== 'offline',
    model: process.env.LLM_MODEL || (provider === 'bedrock' ? 'anthropic.claude-opus-5-5' : 'claude-opus-5-5'),
  };
}

function client() {
  if (cached) return cached;
  const info = llmInfo();
  if (info.provider === 'bedrock') {
    cached = { info, sdk: new AnthropicBedrockMantle({ awsRegion: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-west-1' }), beta: false };
  } else if (info.provider === 'anthropic') {
    cached = { info, sdk: new Anthropic(), beta: true };
  } else {
    cached = { info, sdk: null };
  }
  return cached;
}

export class RefusalError extends Error {}

function params({ system, messages, effort = 'medium', maxTokens = 16000, format }) {
  const { info, beta } = client();
  const p = {
    model: info.model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort, ...(format ? { format } : {}) },
  };
  // Server-side fallback re-runs a declined request on Anthropic's recommended model.
  if (beta) Object.assign(p, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  return p;
}

function messagesApi() {
  const { sdk, beta } = client();
  return beta ? sdk.beta.messages : sdk.messages;
}

// Streams text deltas to onText and resolves with the full text.
export async function streamText(opts, onText) {
  const stream = messagesApi().stream(params(opts));
  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
      onText?.(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new RefusalError('The model declined this request.');
  return text;
}

// Returns parsed JSON constrained to the given JSON schema.
export async function generateJson({ system, messages, schema, effort = 'medium', maxTokens = 16000 }) {
  const stream = messagesApi().stream(params({
    system, messages, effort, maxTokens, format: { type: 'json_schema', schema },
  }));
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new RefusalError('The model declined this request.');
  if (final.stop_reason === 'max_tokens') throw new Error('Response was cut off before completion.');
  const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}
