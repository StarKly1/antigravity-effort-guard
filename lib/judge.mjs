import { normalizeEffort } from './effort.mjs';

export const DEFAULT_JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';

// TypeSafe AI System One pricing: $0.042 per 1M input tokens, output tokens free.
const INPUT_COST_PER_M_USD = 0.042;
const FALLBACK_COST_PER_TURN_USD = 0.00001;

const EFFORT_CRITERIA = Object.freeze({
  low: 'Factual lookups, CLI/syntax questions, typo fixes, single-symbol renames, status checks, short explanations, or simple git/shell commands.',
  medium:
    'Scoped single-module implementation, writing unit tests, moderate bug fixes, UI component or form updates, API wiring, or bounded refactors across 1-3 files.',
  high: 'Multi-file architectural design or refactoring, subtle race conditions or distributed state debugging, security/auth/RBAC redesign, cross-cutting migrations, deep performance profiling, or complex system planning.',
});

export function resolveJevApiKey(env = process.env) {
  const typesafe = env?.TYPESAFE_API_KEY?.trim();
  if (typesafe) return { key: typesafe, envVar: 'TYPESAFE_API_KEY' };
  const jev = env?.JEV_API_KEY?.trim();
  if (jev) return { key: jev, envVar: 'JEV_API_KEY' };
  return { key: '', envVar: 'TYPESAFE_API_KEY' };
}

export function resolveJevApiUrl(env = process.env) {
  const custom = env?.JEV_API_URL?.trim() || env?.TYPESAFE_API_URL?.trim();
  return custom || DEFAULT_JEV_API_URL;
}

function estimateCostUsd(usage) {
  if (usage && typeof usage === 'object') {
    const inputTokens = Number(usage.input_tokens) || 0;
    if (inputTokens > 0) {
      return (inputTokens * INPUT_COST_PER_M_USD) / 1_000_000;
    }
  }
  return FALLBACK_COST_PER_TURN_USD;
}

function clampProb(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
}

function formatProbDistribution(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') return '';
  const l = clampProb(probabilities.low);
  const m = clampProb(probabilities.medium);
  const h = clampProb(probabilities.high);
  if (l === null && m === null && h === null) return '';
  const fmt = (v) => (v === null ? '–' : `${Math.round(v * 100)}%`);
  return `L ${fmt(l)} / M ${fmt(m)} / H ${fmt(h)}`;
}

function buildDeterministicReason(level, probabilities, answers) {
  const simpleP = clampProb(answers?.simple_lookup?.noul);
  const scopedP = clampProb(answers?.scoped_implementation?.noul);
  const archP = clampProb(answers?.multi_file_architecture?.noul);

  let headline = '';
  if (level === 'low') {
    headline =
      simpleP !== null && simpleP >= 0.6
        ? `Simple lookup or trivial edit (${Math.round(simpleP * 100)}% signal)`
        : 'Low-complexity task; minimal thinking budget needed';
  } else if (level === 'medium') {
    headline =
      scopedP !== null && scopedP >= 0.6
        ? `Scoped module implementation or testing (${Math.round(scopedP * 100)}% signal)`
        : 'Bounded single-module coding task';
  } else {
    headline =
      archP !== null && archP >= 0.6
        ? `Multi-file architecture or complex invariants (${Math.round(archP * 100)}% signal)`
        : 'High-complexity synthesis or deep debugging required';
  }

  const dist = formatProbDistribution(probabilities);
  return dist ? `${headline} · ${dist}.` : `${headline}.`;
}

/**
 * Parse a TypeSafe AI System One Jev response envelope.
 */
export function parseJevResponse(data) {
  if (!data || typeof data !== 'object') return null;
  const answers = data.answers;
  if (!answers || typeof answers !== 'object') return null;

  const effortAns = answers.effort;
  if (!effortAns || typeof effortAns !== 'object') return null;

  const level = normalizeEffort(effortAns.choice);
  if (!level) return null;

  const probs =
    effortAns.probabilities && typeof effortAns.probabilities === 'object'
      ? effortAns.probabilities
      : null;

  const rawConf = clampProb(effortAns.confidence);
  const choiceProb = probs ? clampProb(probs[level]) : null;
  const effectiveProb = rawConf !== null ? rawConf : choiceProb !== null ? choiceProb : 0.8;
  const confidence = Math.max(0, Math.min(100, Math.round(effectiveProb * 100)));

  const reason = buildDeterministicReason(level, probs, answers);

  return {
    level,
    confidence,
    probabilities: probs,
    reason,
    resolvedModel: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null,
  };
}

/**
 * Call TypeSafe AI's Jev System One API to classify prompt reasoning effort
 * with calibrated probabilities and a strict fail-open timeout.
 *
 * Always resolves (never rejects):
 * - { ok: true, level, confidence, probabilities, reason, latencyMs, costUsd, model }
 * - { ok: false, errorType: "no_key" | "timeout" | "api_error" | "parse_error", reason, latencyMs, costUsd: 0, model }
 */
export async function judgePrompt({
  prompt,
  model = DEFAULT_JEV_MODEL,
  timeoutMs = 2500,
  apiKey,
  apiUrl,
  fetchImpl = globalThis.fetch,
}) {
  const startedAt = Date.now();
  const resolvedKey =
    apiKey !== undefined ? { key: String(apiKey || '').trim(), envVar: 'TYPESAFE_API_KEY' } : resolveJevApiKey();

  if (!resolvedKey.key) {
    return {
      ok: false,
      errorType: 'no_key',
      reason: 'TYPESAFE_API_KEY (or JEV_API_KEY) is not set. Failed open so your turn was never blocked.',
      latencyMs: 0,
      costUsd: 0,
      model,
    };
  }

  const safeTimeout = Math.max(250, Math.min(4000, Number(timeoutMs) || 2500));
  const clippedPrompt = String(prompt || '').trim().slice(0, 3200);
  const endpoint = apiUrl || resolveJevApiUrl();

  const body = {
    model,
    state: clippedPrompt,
    questions: {
      effort: {
        type: 'choice',
        instructions:
          'What minimum model reasoning effort tier is required to answer this user prompt accurately and thoroughly?',
        criteria: EFFORT_CRITERIA,
      },
      simple_lookup: {
        type: 'noul',
        instructions:
          'Is this a simple factual lookup, single command question, or trivial single-line edit?',
      },
      scoped_implementation: {
        type: 'noul',
        instructions:
          'Is this a bounded single-module implementation, unit test suite, or moderate bug fix?',
      },
      multi_file_architecture: {
        type: 'noul',
        instructions:
          'Does this require multi-file architectural design, complex debugging, or cross-cutting security/state invariants?',
      },
    },
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, safeTimeout);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolvedKey.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Math.max(1, Date.now() - startedAt);

    if (!res.ok) {
      return {
        ok: false,
        errorType: 'api_error',
        reason: `Jev API returned HTTP ${res.status}. Failed open so your turn was never blocked.`,
        latencyMs,
        costUsd: 0,
        model,
      };
    }

    const data = await res.json();
    const parsed = parseJevResponse(data);
    if (!parsed) {
      return {
        ok: false,
        errorType: 'parse_error',
        reason: 'Jev API returned an unexpected response schema. Failed open so your turn was never blocked.',
        latencyMs,
        costUsd: estimateCostUsd(data?.usage),
        model,
      };
    }

    return {
      ok: true,
      level: parsed.level,
      confidence: parsed.confidence,
      probabilities: parsed.probabilities,
      reason: parsed.reason,
      latencyMs,
      costUsd: estimateCostUsd(data?.usage),
      model: parsed.resolvedModel || model,
    };
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - startedAt);
    const isAbort = timedOut || err?.name === 'AbortError';
    if (isAbort) {
      return {
        ok: false,
        errorType: 'timeout',
        reason: `Jev API exceeded ${(safeTimeout / 1000).toFixed(1)}s timeout. Failed open so your turn was never blocked.`,
        latencyMs: Math.max(latencyMs, safeTimeout),
        costUsd: 0,
        model,
      };
    }
    return {
      ok: false,
      errorType: 'api_error',
      reason: `Jev API unreachable (${err?.message || 'network error'}). Failed open so your turn was never blocked.`,
      latencyMs,
      costUsd: 0,
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}
