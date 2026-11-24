import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseEffortFromModelString,
  resolveActiveEffort,
  evaluatePolicy,
} from '../lib/effort.mjs';
import { parseJevResponse, judgePrompt, DEFAULT_JEV_API_URL } from '../lib/judge.mjs';
import { loadSettings, getHudSnapshot } from '../lib/store.mjs';
import { handlePreInvocation } from '../scripts/effort_guard.mjs';
import { createEffortGuardServer } from '../sidecars/effort-guard/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'effort-guard-test-'));
}

test('parseEffortFromModelString detects effort tiers accurately', () => {
  assert.equal(parseEffortFromModelString('gemini-4-neon-high'), 'high');
  assert.equal(parseEffortFromModelString('Gemini 4 Neon (High)'), 'high');
  assert.equal(parseEffortFromModelString('gemini-4-neon-medium'), 'medium');
  assert.equal(parseEffortFromModelString('Gemini 4 Neon (Med)'), 'medium');
  assert.equal(parseEffortFromModelString('gemini-3-pro-low'), 'low');
  assert.equal(parseEffortFromModelString('auto'), null);
  assert.equal(parseEffortFromModelString('highlight-model'), null);
});

test('resolveActiveEffort falls back to transcript when modelName is auto', () => {
  const dir = makeTempDir();
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'USER_INPUT', content: 'hello' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high' }),
    ].join('\n'),
    'utf-8'
  );

  const res = resolveActiveEffort({ modelName: 'auto', transcriptPath });
  assert.equal(res.effort, 'high');
  assert.equal(res.model, 'gemini-4-neon-high');
});

test('evaluatePolicy respects triggerRule, confThreshold, mode, and Save Mode', () => {
  const base = { mode: 'guard', triggerRule: 'any', saveMode: true, confThreshold: 85 };

  const paused = evaluatePolicy({
    activeEffort: 'high',
    judgeLevel: 'low',
    confidence: 94,
    settings: base,
  });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.estimatedSavedTokensK, 12);

  const lowConf = evaluatePolicy({
    activeEffort: 'high',
    judgeLevel: 'low',
    confidence: 75,
    settings: base,
  });
  assert.equal(lowConf.status, 'passed');

  const gap1Two = evaluatePolicy({
    activeEffort: 'high',
    judgeLevel: 'medium',
    confidence: 92,
    settings: { ...base, triggerRule: 'two' },
  });
  assert.equal(gap1Two.status, 'passed');

  const gap2Two = evaluatePolicy({
    activeEffort: 'high',
    judgeLevel: 'low',
    confidence: 92,
    settings: { ...base, triggerRule: 'two' },
  });
  assert.equal(gap2Two.status, 'paused');

  const passive = evaluatePolicy({
    activeEffort: 'high',
    judgeLevel: 'low',
    confidence: 94,
    settings: { ...base, mode: 'passive' },
  });
  assert.equal(passive.status, 'advisory');

  const capped = evaluatePolicy({
    activeEffort: 'high',
    judgeLevel: 'high',
    confidence: 90,
    settings: base,
    quotaPct: 84,
  });
  assert.equal(capped.saveModeCapped, true);
  assert.equal(capped.effectiveLevel, 'medium');
  assert.equal(capped.status, 'paused');
});

test('parseJevResponse parses System One choice + parallel noul signals', () => {
  const parsed = parseJevResponse({
    model: 'jev-1.14.0',
    answers: {
      effort: {
        type: 'choice',
        choice: 'low',
        probabilities: { low: 0.94, medium: 0.05, high: 0.01 },
        confidence: 0.91,
      },
      simple_lookup: { type: 'noul', noul: 0.96 },
      scoped_implementation: { type: 'noul', noul: 0.08 },
      multi_file_architecture: { type: 'noul', noul: 0.02 },
    },
  });

  assert.equal(parsed.level, 'low');
  assert.equal(parsed.confidence, 91);
  assert.equal(parsed.resolvedModel, 'jev-1.14.0');
  assert.match(parsed.reason, /96% signal/);
  assert.match(parsed.reason, /L 94% \/ M 5% \/ H 1%/);

  assert.equal(parseJevResponse({ answers: {} }), null);
});

test('judgePrompt calls Jev System One API properly and fails open on missing key or timeout', async () => {
  const noKey = await judgePrompt({ prompt: 'hi', apiKey: '' });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.errorType, 'no_key');

  let seenUrl = '';
  let seenAuth = '';
  let seenBody = null;
  const mockOkFetch = async (url, opts) => {
    seenUrl = url;
    seenAuth = opts.headers.Authorization;
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-1.14.0',
        answers: {
          effort: {
            type: 'choice',
            choice: 'low',
            probabilities: { low: 0.95, medium: 0.04, high: 0.01 },
            confidence: 0.92,
          },
          simple_lookup: { type: 'noul', noul: 0.97 },
        },
        usage: { input_tokens: 200, output_tokens: 0 },
      }),
    };
  };

  const okRes = await judgePrompt({
    prompt: 'What does git stash pop do?',
    model: 'jev-latest',
    apiKey: 'ts_test_123',
    fetchImpl: mockOkFetch,
  });
  assert.equal(seenUrl, DEFAULT_JEV_API_URL);
  assert.equal(seenAuth, 'Bearer ts_test_123');
  assert.equal(seenBody.model, 'jev-latest');
  assert.equal(seenBody.questions.effort.type, 'choice');
  assert.equal(seenBody.questions.simple_lookup.type, 'noul');
  assert.equal(okRes.ok, true);
  assert.equal(okRes.level, 'low');
  assert.equal(okRes.confidence, 92);
  assert.equal(okRes.model, 'jev-1.14.0');
  assert.ok(okRes.costUsd > 0 && okRes.costUsd < 0.0001);

  const slowFetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  const timedOut = await judgePrompt({
    prompt: 'What does git stash pop do?',
    apiKey: 'ts_test_123',
    timeoutMs: 250,
    fetchImpl: slowFetch,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.errorType, 'timeout');
});

test('handlePreInvocation gates invocationNum === 0, ! bypass, guard pause, and cache-safe matched/advisory', async () => {
  const dataDir = makeTempDir();

  const skipped = await handlePreInvocation(
    {
      hookEventName: 'PreInvocation',
      invocationNum: 1,
      conversationId: 'conv-1',
      modelName: 'gemini-4-neon-high',
      lastUserInput: 'What does git stash pop do?',
    },
    { dataDir, apiKey: 'ts_test_123' }
  );
  assert.deepEqual(skipped, {});

  let judgeCalled = false;
  const forced = await handlePreInvocation(
    {
      hookEventName: 'PreInvocation',
      invocationNum: 0,
      conversationId: 'conv-1',
      modelName: 'gemini-4-neon-high',
      lastUserInput: '!Fix typo on line 12',
    },
    {
      dataDir,
      apiKey: 'ts_test_123',
      judgePrompt: async () => {
        judgeCalled = true;
        return { ok: true, level: 'low', confidence: 99, reason: 'should not run', latencyMs: 10, costUsd: 0 };
      },
    }
  );
  assert.equal(judgeCalled, false);
  assert.equal(forced.terminationBehavior, undefined);
  assert.equal(forced.injectSteps[0].systemMessage.systemMessage, '');
  assert.match(forced.injectSteps[0].systemMessage.metadata.user_markdown, /Bypassed via `!`/);

  const paused = await handlePreInvocation(
    {
      hookEventName: 'PreInvocation',
      invocationNum: 0,
      conversationId: 'conv-1',
      modelName: 'gemini-4-neon-high',
      lastUserInput: 'What does git stash pop do?',
    },
    {
      dataDir,
      apiKey: 'ts_test_123',
      judgePrompt: async () => ({
        ok: true,
        level: 'low',
        confidence: 92,
        reason: 'Simple lookup or trivial edit (96% signal) · L 94% / M 5% / H 1%.',
        latencyMs: 65,
        costUsd: 0.000008,
        model: 'jev-1.14.0',
      }),
    }
  );
  assert.equal(paused.terminationBehavior, 'terminate');
  assert.match(paused.injectSteps[0].errorMessage.userMessage, /LOW recommended/);
  assert.match(paused.injectSteps[0].errorMessage.userMessage, /Active: HIGH/);
  assert.match(paused.injectSteps[0].errorMessage.userMessage, /jev-1\.14\.0/);

  const matched = await handlePreInvocation(
    {
      hookEventName: 'PreInvocation',
      invocationNum: 0,
      conversationId: 'conv-1',
      modelName: 'gemini-4-neon-low',
      lastUserInput: 'What does git stash pop do?',
    },
    {
      dataDir,
      apiKey: 'ts_test_123',
      judgePrompt: async () => ({
        ok: true,
        level: 'low',
        confidence: 92,
        reason: 'Simple lookup or trivial edit (96% signal) · L 94% / M 5% / H 1%.',
        latencyMs: 62,
        costUsd: 0.000008,
        model: 'jev-1.14.0',
      }),
    }
  );
  assert.equal(matched.terminationBehavior, undefined);
  assert.equal(matched.injectSteps[0].systemMessage.systemMessage, '');
  assert.match(matched.injectSteps[0].systemMessage.metadata.user_markdown, /Matched LOW/);

  const snap = getHudSnapshot('conv-1', dataDir);
  assert.equal(snap.hasData, true);
  assert.equal(snap.stats.paused, 1);
  assert.equal(snap.stats.savedTokensK, 12);
  assert.equal(snap.history.length, 2);
});

test('effort_guard.mjs CLI fails open cleanly when TYPESAFE_API_KEY and JEV_API_KEY are missing', () => {
  const dataDir = makeTempDir();
  const res = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'effort_guard.mjs')],
    {
      input: JSON.stringify({
        hookEventName: 'PreInvocation',
        invocationNum: 0,
        conversationId: 'conv-cli',
        modelName: 'gemini-4-neon-high',
        lastUserInput: 'What does git status show?',
      }),
      env: {
        ...process.env,
        TYPESAFE_API_KEY: '',
        JEV_API_KEY: '',
        EFFORT_GUARD_DATA_DIR: dataDir,
      },
      encoding: 'utf-8',
    }
  );

  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), {});

  const snap = getHudSnapshot('conv-cli', dataDir);
  assert.equal(snap.currentTurn?.verdict?.status, 'no_key');
});

test('sidecar server serves Jev UI, updates settings live, and supports fail-open test', async () => {
  const dataDir = makeTempDir();
  const server = createEffortGuardServer({ dataDir });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { ok: true });

    const uiRes = await fetch(`${baseUrl}/?conversationId=conv-ui&token=abc123`);
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.match(html, /Jev System One/);
    assert.match(html, /\/preload\.js\?token=abc123&conversationId=conv-ui/);

    const patchRes = await fetch(`${baseUrl}/api/settings?conversationId=conv-ui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'passive',
        triggerRule: 'two',
        saveMode: false,
        judgeModel: 'jev-1.14',
        confThreshold: 90,
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.settings.mode, 'passive');
    assert.equal(patched.settings.triggerRule, 'two');
    assert.equal(patched.settings.saveMode, false);
    assert.equal(patched.settings.judgeModel, 'jev-1.14');
    assert.equal(patched.settings.confThreshold, 90);

    const persisted = loadSettings(dataDir);
    assert.equal(persisted.mode, 'passive');
    assert.equal(persisted.judgeModel, 'jev-1.14');

    const csrfRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ mode: 'off' }),
    });
    assert.equal(csrfRes.status, 403);

    const failOpenRes = await fetch(`${baseUrl}/api/test-fail-open?conversationId=conv-ui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(failOpenRes.status, 200);
    const failOpenSnap = await failOpenRes.json();
    assert.equal(failOpenSnap.currentTurn.verdict.status, 'timeout');
    assert.equal(failOpenSnap.stats.paused, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
