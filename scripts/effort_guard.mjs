import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveActiveEffort, evaluatePolicy } from '../lib/effort.mjs';
import { judgePrompt, resolveJevApiKey } from '../lib/judge.mjs';
import { getDataDir, loadSettings, recordTurn } from '../lib/store.mjs';

const __filename = fileURLToPath(import.meta.url);

const SIDECAR_LINK = '[HUD](sidecar://effort-guard/effort-guard/)';

function extractPromptText(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  // Unwrap <USER_REQUEST>...</USER_REQUEST> if present
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) {
    text = match[1].trim();
  }
  return text;
}

function makeUserMarkdownResponse(markdown) {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: markdown,
          },
        },
      },
    ],
  };
}

function makePauseResponse({ recommendedLevel, activeEffort, confidence, reason, judgeModel, latencyMs }) {
  const recUpper = recommendedLevel.toUpperCase();
  const activeUpper = (activeEffort || 'HIGH').toUpperCase();
  const lines = [
    `Effort Guard paused this turn — ${recUpper} recommended (${confidence}% conf) · Active: ${activeUpper}`,
    `${reason} Switch the model selector to ${recUpper} and resend, or prefix \`!\` to force ${activeUpper}.`,
    `0 thinking tokens spent · ${judgeModel} · ${latencyMs} ms`,
  ];
  return {
    injectSteps: [
      {
        errorMessage: {
          userMessage: lines.join('\n'),
        },
      },
    ],
    terminationBehavior: 'terminate',
  };
}

export async function handlePreInvocation(payload, deps = {}) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  // PreInvocation only
  if (payload.hookEventName && String(payload.hookEventName) !== 'PreInvocation') {
    return {};
  }

  // Run strictly on invocationNum === 0 (first invocation of a user turn)
  if (payload.invocationNum == null || Number(payload.invocationNum) !== 0) {
    return {};
  }

  const prompt = extractPromptText(payload.lastUserInput);
  if (!prompt) {
    return {};
  }

  const dataDir = deps.dataDir || getDataDir();
  const settings = deps.settings || loadSettings(dataDir);
  const convId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
  const { effort: activeEffort, model: activeModel } = resolveActiveEffort(payload);
  const activeLabel = activeEffort ? activeEffort.toUpperCase() : 'ACTIVE';

  // Mode OFF: pass straight through with zero injected steps
  if (settings.mode === 'off') {
    recordTurn(
      {
        conversationId: convId,
        prompt,
        activeEffort,
        activeModel,
        judgeModel: settings.judgeModel,
        verdict: {
          level: activeEffort || 'medium',
          effectiveLevel: activeEffort || 'medium',
          confidence: 100,
          latencyMs: 0,
          reason: 'Effort Guard is turned off. Prompt passed straight through.',
          status: 'off',
          costUsd: 0,
        },
      },
      dataDir
    );
    return {};
  }

  // Prefix `!` bypasses the judge immediately
  if (prompt.startsWith('!')) {
    const started = Date.now();
    const latencyMs = Math.max(1, Date.now() - started);
    recordTurn(
      {
        conversationId: convId,
        prompt,
        activeEffort,
        activeModel,
        judgeModel: settings.judgeModel,
        verdict: {
          level: activeEffort || 'high',
          effectiveLevel: activeEffort || 'high',
          confidence: 100,
          latencyMs,
          reason: 'Bypassed via ! prefix — keeping active effort without calling judge.',
          status: 'forced',
          costUsd: 0,
        },
      },
      dataDir
    );

    return makeUserMarkdownResponse(
      `✓ **Effort Guard** · \`${activeLabel}\` · Bypassed via \`!\` prefix · ${latencyMs} ms · ${SIDECAR_LINK}`
    );
  }

  const apiKey =
    deps.apiKey !== undefined ? deps.apiKey : resolveJevApiKey().key;

  // Missing key: strict fail-open, never block
  if (!apiKey) {
    recordTurn(
      {
        conversationId: convId,
        prompt,
        activeEffort,
        activeModel,
        judgeModel: settings.judgeModel,
        verdict: {
          level: activeEffort || 'medium',
          effectiveLevel: activeEffort || 'medium',
          confidence: 0,
          latencyMs: 0,
          reason: 'TYPESAFE_API_KEY (or JEV_API_KEY) is not set. Failed open so your turn was never blocked.',
          status: 'no_key',
          costUsd: 0,
        },
      },
      dataDir
    );
    return {};
  }

  const judgeFn = deps.judgePrompt || judgePrompt;
  const judged = await judgeFn({
    prompt,
    model: settings.judgeModel,
    timeoutMs: settings.timeoutMs || 2500,
    apiKey,
    apiUrl: deps.apiUrl,
    fetchImpl: deps.fetchImpl,
  });

  // Strict fail-open on timeout, network error, or malformed response
  if (!judged.ok) {
    const isTimeout = judged.errorType === 'timeout';
    recordTurn(
      {
        conversationId: convId,
        prompt,
        activeEffort,
        activeModel,
        judgeModel: settings.judgeModel,
        verdict: {
          level: activeEffort || 'medium',
          effectiveLevel: activeEffort || 'medium',
          confidence: 0,
          latencyMs: judged.latencyMs || (isTimeout ? settings.timeoutMs || 2500 : 0),
          reason: judged.reason,
          status: isTimeout ? 'timeout' : 'error',
          costUsd: judged.costUsd || 0,
        },
      },
      dataDir
    );

    const shortNote = isTimeout
      ? `Judge timed out (>${((settings.timeoutMs || 2500) / 1000).toFixed(1)}s) — failed open on \`${activeLabel}\``
      : `Judge unavailable — failed open on \`${activeLabel}\``;

    return makeUserMarkdownResponse(
      `⚠ **Effort Guard** · ${shortNote} · ${judged.latencyMs || 0} ms · ${SIDECAR_LINK}`
    );
  }

  const policy = evaluatePolicy({
    activeEffort,
    judgeLevel: judged.level,
    confidence: judged.confidence,
    settings,
    quotaPct: deps.quotaPct ?? null,
  });

  recordTurn(
    {
      conversationId: convId,
      prompt,
      activeEffort,
      activeModel,
      judgeModel: judged.model || settings.judgeModel,
      estimatedSavedTokensK: policy.estimatedSavedTokensK,
      verdict: {
        level: judged.level,
        effectiveLevel: policy.effectiveLevel,
        confidence: judged.confidence,
        latencyMs: judged.latencyMs,
        reason: judged.reason,
        status: policy.status,
        costUsd: judged.costUsd,
        saveModeCapped: policy.saveModeCapped,
      },
    },
    dataDir
  );

  if (policy.status === 'paused') {
    return makePauseResponse({
      recommendedLevel: policy.effectiveLevel,
      activeEffort,
      confidence: judged.confidence,
      reason: judged.reason,
      judgeModel: judged.model || settings.judgeModel,
      latencyMs: judged.latencyMs,
    });
  }

  const recUpper = policy.effectiveLevel.toUpperCase();

  if (policy.status === 'advisory') {
    return makeUserMarkdownResponse(
      `⚡ **Effort Guard** · **${recUpper}** suggested (${judged.confidence}%) · Active: \`${activeLabel}\` · ${judged.latencyMs} ms — ${judged.reason} · ${SIDECAR_LINK}`
    );
  }

  const matchLabel = activeEffort
    ? `Matched ${activeUpperOr(activeEffort)}`
    : `${judged.confidence}% conf`;

  return makeUserMarkdownResponse(
    `✓ **Effort Guard** · \`${recUpper}\` · ${matchLabel} · ${judged.latencyMs} ms · ${SIDECAR_LINK}`
  );
}

function activeUpperOr(effort) {
  return effort ? effort.toUpperCase() : 'ACTIVE';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  try {
    const raw = (await readStdin()).replace(/^\uFEFF/, '').trim();
    if (!raw) {
      process.stdout.write('{}\n');
      return;
    }
    const payload = JSON.parse(raw);
    const response = await handlePreInvocation(payload);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Strict fail-open: never crash or block a turn
    process.stdout.write('{}\n');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main();
}
