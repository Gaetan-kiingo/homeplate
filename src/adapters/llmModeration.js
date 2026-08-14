// src/adapters/llmModeration.js — U2-MEDIA-LLM: provider-agnostic moderation LLM adapter
// (ADR-007). classify(text) returns {category, confidence, model} for the ADR-002 two-stage
// moderation pipeline (deterministic pre-filter first, then this classifier).
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08, IT-03) — the LLM stage of moderation. The provider is configured ONLY by
//                    LLM_MODERATION_BASE_URL / LLM_MODERATION_API_KEY / MODERATION_MODEL
//                    (src/config → .env.example); no provider name, model id or key appears
//                    in this source, so switching providers is one environment change.
//   NFR-10 (IT-03) — every result carries the model id that produced it (from config), so
//                    IT-03 measurements are recorded against the exact model (ADR-007/008).
//   NFR-09 (RT-01) — the HTTPS call runs under withResilience via src/lib/httpClient
//                    (per-attempt timeout, bounded retries, exponential backoff). Any
//                    provider failure — network, 5xx, quota, malformed or unusable output —
//                    surfaces as the typed ModerationProviderError so the wave-4 pipeline
//                    keeps public content 'pending', never publishing unreviewed (ADR-002).
//   NFR-13         — content text goes only to the configured provider endpoint over HTTPS;
//                    it is NEVER logged here (httpClient logs method + host only).
//
// ADR-001/ADR-003 — WORKER-ONLY MODULE: only src/outbox/handlers/* and worker code may
// import it; request handlers never call the classifier inline.
//
// Mode resolution (ADR-007): config.moderation.mode === 'mock' (the NODE_ENV=test and dev
// default, enforced by src/config) resolves the deterministic mock in ./llmModeration.mock;
// 'live' builds the real HTTPS adapter. Only the IT-03 measurement run uses live.
'use strict';

const config = require('../config');
const httpClient = require('../lib/httpClient');
const mockAdapter = require('./llmModeration.mock');

const { ModerationProviderError, CATEGORIES } = mockAdapter;

// REST path template of the configured provider family. The host (base URL), model id and
// key are environment-only (ADR-007); this template contains none of them.
const CLASSIFY_PATH_TEMPLATE = '/v1beta/models/{model}:generateContent';

// ADR-002: the classifier judges content against an embedded safety policy and must answer
// in strict JSON so the pipeline can apply confidence-threshold routing (FR-08).
const SAFETY_POLICY_PROMPT = [
  'You are a strict content-safety classifier for a home-cooked-meal marketplace.',
  'Classify the user-generated content between the CONTENT markers into exactly one category:',
  '- "offensive": harassment, hate, threats, sexual content, or abusive language',
  '- "spam": unsolicited advertising, repeated promotion, link farming, or bulk solicitation',
  '- "fraudulent": scams, phishing, impersonation, or attempts to move payment off the platform',
  '- "benign": ordinary marketplace content with none of the above',
  'Respond with ONLY a JSON object of the form',
  '{"category": "offensive|spam|fraudulent|benign", "confidence": <number between 0 and 1>}',
  'with no additional text.',
].join('\n');

function buildPrompt(text) {
  return `${SAFETY_POLICY_PROMPT}\n<CONTENT>\n${text}\n</CONTENT>`;
}

/**
 * Pulls a {category, confidence} object out of the provider response. Accepts either the
 * classification JSON directly, or the configured provider family's chat-completion shape
 * (candidates[0].content.parts[*].text holding the JSON, possibly fenced).
 * Returns undefined when nothing usable is present.
 */
function extractClassification(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (typeof payload.category === 'string') return payload;

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parts =
    candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
      ? candidates[0].content.parts
      : [];
  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  if (!text) return undefined;

  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch (_err) {
    return undefined;
  }
}

/** Validates the taxonomy contract: category from CATEGORIES, confidence a number in [0,1]. */
function isValidClassification(result) {
  return (
    result !== undefined &&
    result !== null &&
    CATEGORIES.includes(result.category) &&
    typeof result.confidence === 'number' &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1
  );
}

/**
 * Builds the live HTTPS adapter. Connection facts default from config.moderation (which
 * requires all three variables in live mode); tests inject overrides plus a fake fetchImpl.
 *
 * @param {object} [overrides] { baseUrl, apiKey, model, timeoutMs, retries, backoff,
 *                               fetchImpl, log }
 * @returns {{mode: 'live', model: string, classify: function(string): Promise<object>}}
 */
function createLiveLlmModerationAdapter(overrides = {}) {
  const baseUrl = overrides.baseUrl ?? config.moderation.baseUrl;
  const apiKey = overrides.apiKey ?? config.moderation.apiKey;
  const model = overrides.model ?? config.moderation.model;
  const timeoutMs = overrides.timeoutMs ?? config.adapters.timeoutMs;
  const retries = overrides.retries ?? config.adapters.retryMax;
  const backoff = overrides.backoff ?? { baseMs: config.adapters.backoffBaseMs };

  if (!baseUrl || !apiKey || !model) {
    // Fail fast, mirroring src/config's live-mode requirements (ADR-007).
    throw new Error(
      'llmModeration live mode requires LLM_MODERATION_BASE_URL, LLM_MODERATION_API_KEY and MODERATION_MODEL'
    );
  }

  const endpoint = new URL(
    baseUrl.replace(/\/+$/, '') +
      CLASSIFY_PATH_TEMPLATE.replace('{model}', encodeURIComponent(model))
  );
  // Credential travels as a query parameter accepted by the configured provider family; the
  // value comes from the environment only and never appears in logs (httpClient logs host only).
  endpoint.searchParams.set('key', apiKey);

  /**
   * Classifies one piece of user-generated content.
   * @param {string} text
   * @returns {Promise<{category: string, confidence: number, model: string}>}
   * @throws {ModerationProviderError} on any provider failure or unusable output —
   *         retryable unless the underlying fault is permanent (e.g. rejected credentials).
   */
  async function classify(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new TypeError('llmModeration.classify(text): text must be a non-empty string');
    }

    let response;
    try {
      response = await httpClient.request({
        url: endpoint.toString(),
        method: 'POST',
        json: {
          contents: [{ role: 'user', parts: [{ text: buildPrompt(text) }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        },
        timeoutMs,
        retries,
        backoff,
        fetchImpl: overrides.fetchImpl,
        log: overrides.log,
        name: 'llmModeration.classify',
      });
    } catch (err) {
      // Preserve retryability: transient faults (network, 5xx, 429, 408, timeout) keep
      // retryable=true so the worker backs off and content stays pending (ADR-002);
      // permanent faults (rejected key, other 4xx) dead-letter instead of spinning.
      throw new ModerationProviderError('Moderation provider call failed', {
        retryable: !(err && err.retryable === false),
        cause: err,
      });
    }

    const classification = extractClassification(response.json);
    if (!isValidClassification(classification)) {
      // Unusable output is a provider fault, not an approval: surfaces retryable so the
      // pipeline retries and public content stays pending — never published unreviewed.
      throw new ModerationProviderError('Moderation provider returned an unusable classification', {
        retryable: true,
      });
    }

    return { category: classification.category, confidence: classification.confidence, model };
  }

  return { mode: 'live', model, classify };
}

// ---- mode resolution (ADR-007) ----------------------------------------------------------------
// NODE_ENV=test always resolves the mock: src/config derives moderation.mode='mock' outside
// production unless LLM_MODERATION_MODE overrides it, and tests/helpers/env.js pins 'mock'.
const adapter = config.moderation.mode === 'live' ? createLiveLlmModerationAdapter() : mockAdapter;

module.exports = {
  mode: adapter.mode,
  model: adapter.model,
  /** classify(text) -> {category, confidence, model} via the mode-resolved adapter. */
  classify: (text) => adapter.classify(text),
  createLiveLlmModerationAdapter,
  ModerationProviderError,
  CATEGORIES,
  mock: mockAdapter,
};
