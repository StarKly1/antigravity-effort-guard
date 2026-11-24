import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_JEV_MODEL, resolveJevApiKey } from './judge.mjs';

export const ALLOWED_MODES = new Set(['guard', 'passive', 'off']);
export const ALLOWED_TRIGGER_RULES = new Set(['any', 'two', 'save']);
export const ALLOWED_JUDGE_MODELS = new Set(['jev-latest', 'jev-1.14', 'jev-1.13']);

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'guard',
  triggerRule: 'any',
  saveMode: true,
  judgeModel: DEFAULT_JEV_MODEL,
  confThreshold: 85,
  timeoutMs: 2500,
});

const MAX_HISTORY_PER_CONV = 20;
const MAX_GLOBAL_RECENT = 20;
const MAX_CONVERSATIONS = 40;

export function getAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

export function getDataDir() {
  const explicit = process.env.EFFORT_GUARD_DATA_DIR?.trim();
  if (explicit) return explicit;
  return path.join(getAppDataDir(), 'effort-guard');
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // Ignore race or permission errors — fail open
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, serialized, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    try {
      fs.writeFileSync(filePath, serialized, 'utf-8');
    } catch {}
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...(base || {}) };
  if (input && typeof input === 'object') {
    if (typeof input.mode === 'string' && ALLOWED_MODES.has(input.mode)) {
      merged.mode = input.mode;
    }
    if (typeof input.triggerRule === 'string' && ALLOWED_TRIGGER_RULES.has(input.triggerRule)) {
      merged.triggerRule = input.triggerRule;
    }
    if (typeof input.saveMode === 'boolean') {
      merged.saveMode = input.saveMode;
    }
    if (
      typeof input.judgeModel === 'string' &&
      (ALLOWED_JUDGE_MODELS.has(input.judgeModel) || /^jev-[a-z0-9._-]+$/i.test(input.judgeModel.trim()))
    ) {
      merged.judgeModel = input.judgeModel.trim();
    }
    if (input.confThreshold != null) {
      const n = Math.round(Number(input.confThreshold));
      if (Number.isFinite(n)) {
        merged.confThreshold = Math.max(70, Math.min(95, n));
      }
    }
    if (input.timeoutMs != null) {
      const t = Math.round(Number(input.timeoutMs));
      if (Number.isFinite(t)) {
        merged.timeoutMs = Math.max(500, Math.min(4000, t));
      }
    }
  }
  return merged;
}

export function getSettingsPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'settings.json');
}

export function getStatePath(dataDir = getDataDir()) {
  return path.join(dataDir, 'state.json');
}

export function loadSettings(dataDir = getDataDir()) {
  const raw = readJsonSafe(getSettingsPath(dataDir), null);
  return sanitizeSettings(raw, DEFAULT_SETTINGS);
}

export function saveSettings(patch, dataDir = getDataDir()) {
  const current = loadSettings(dataDir);
  const next = sanitizeSettings(patch, current);
  const record = {
    ...next,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(getSettingsPath(dataDir), record);
  return record;
}

function createEmptyStats() {
  return {
    paused: 0,
    savedTokensK: 0,
    judgeSpend: 0,
    totalEvaluated: 0,
  };
}

function createEmptyState() {
  return {
    stats: createEmptyStats(),
    conversations: {},
    recentTurns: [],
    updatedAt: null,
  };
}

export function loadState(dataDir = getDataDir()) {
  const raw = readJsonSafe(getStatePath(dataDir), null);
  if (!raw || typeof raw !== 'object') return createEmptyState();
  return {
    stats: {
      ...createEmptyStats(),
      ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}),
    },
    conversations:
      raw.conversations && typeof raw.conversations === 'object' ? raw.conversations : {},
    recentTurns: Array.isArray(raw.recentTurns) ? raw.recentTurns : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function isSafeConvId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{3,128}$/.test(id.trim());
}

/**
 * Record a completed PreInvocation turn verdict into persistent local state.
 */
export function recordTurn(turn, dataDir = getDataDir()) {
  const state = loadState(dataDir);
  const nowIso = turn.timestamp || new Date().toISOString();
  const convId = isSafeConvId(turn.conversationId) ? turn.conversationId.trim() : 'default';

  const cleanPrompt = String(turn.prompt || '').replace(/\s+/g, ' ').trim();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    conversationId: convId,
    prompt: cleanPrompt.slice(0, 240),
    activeEffort: turn.activeEffort || null,
    activeModel: turn.activeModel || null,
    judgeModel: turn.judgeModel || DEFAULT_SETTINGS.judgeModel,
    verdict: {
      level: turn.verdict?.level || 'medium',
      effectiveLevel: turn.verdict?.effectiveLevel || turn.verdict?.level || 'medium',
      confidence: Number.isFinite(Number(turn.verdict?.confidence))
        ? Math.max(0, Math.min(100, Math.round(Number(turn.verdict.confidence))))
        : 0,
      latencyMs: Number.isFinite(Number(turn.verdict?.latencyMs))
        ? Math.max(0, Math.round(Number(turn.verdict.latencyMs)))
        : 0,
      reason: String(turn.verdict?.reason || '').trim().slice(0, 280),
      status: turn.verdict?.status || 'passed',
      costUsd: Number.isFinite(Number(turn.verdict?.costUsd)) ? Number(turn.verdict.costUsd) : 0,
      saveModeCapped: Boolean(turn.verdict?.saveModeCapped),
      synthetic: Boolean(turn.verdict?.synthetic),
    },
    timestamp: nowIso,
  };

  if (!state.conversations[convId]) {
    state.conversations[convId] = {
      currentTurn: null,
      history: [],
      stats: createEmptyStats(),
      updatedAt: nowIso,
    };
  }

  const conv = state.conversations[convId];
  if (conv.currentTurn) {
    conv.history.unshift(conv.currentTurn);
    conv.history = conv.history.slice(0, MAX_HISTORY_PER_CONV);
  }
  conv.currentTurn = entry;
  conv.updatedAt = nowIso;

  // Update stats (skip inflating real stats for synthetic fail-open test clicks)
  if (!entry.verdict.synthetic) {
    const isPaused = entry.verdict.status === 'paused';
    const savedK = Number(turn.estimatedSavedTokensK) || 0;
    const cost = entry.verdict.costUsd || 0;
    const evaluated =
      entry.verdict.status !== 'off' &&
      entry.verdict.status !== 'forced' &&
      entry.verdict.status !== 'no_key';

    for (const target of [conv.stats, state.stats]) {
      if (isPaused) {
        target.paused = (Number(target.paused) || 0) + 1;
        target.savedTokensK = (Number(target.savedTokensK) || 0) + savedK;
      }
      if (evaluated) {
        target.totalEvaluated = (Number(target.totalEvaluated) || 0) + 1;
        target.judgeSpend = Number(((Number(target.judgeSpend) || 0) + cost).toFixed(6));
      }
    }
  }

  // Global recent turns
  state.recentTurns.unshift(entry);
  state.recentTurns = state.recentTurns.slice(0, MAX_GLOBAL_RECENT);
  state.updatedAt = nowIso;

  // Prune oldest conversations if map grows large
  const convKeys = Object.keys(state.conversations);
  if (convKeys.length > MAX_CONVERSATIONS) {
    convKeys
      .sort((a, b) => {
        const ta = Date.parse(state.conversations[a]?.updatedAt || '') || 0;
        const tb = Date.parse(state.conversations[b]?.updatedAt || '') || 0;
        return tb - ta;
      })
      .slice(MAX_CONVERSATIONS)
      .forEach((oldKey) => {
        delete state.conversations[oldKey];
      });
  }

  writeJsonAtomic(getStatePath(dataDir), state);
  return { state, entry };
}

/**
 * Build the view model for the sidecar HUD for a given conversationId (with auto-track fallback).
 */
export function getHudSnapshot(conversationId = '', dataDir = getDataDir()) {
  const settings = loadSettings(dataDir);
  const state = loadState(dataDir);
  const requestedId = isSafeConvId(conversationId) ? conversationId.trim() : '';

  let resolvedConvId = requestedId;
  let conv = requestedId ? state.conversations[requestedId] : null;
  let autoTracked = false;

  if (!conv) {
    // Auto-track the most recently updated conversation
    let bestId = '';
    let bestTs = -1;
    for (const [id, c] of Object.entries(state.conversations)) {
      if (!c || !c.currentTurn) continue;
      const ts = Date.parse(c.updatedAt || c.currentTurn.timestamp || '') || 0;
      if (ts >= bestTs) {
        bestTs = ts;
        bestId = id;
      }
    }
    if (bestId) {
      resolvedConvId = bestId;
      conv = state.conversations[bestId];
      autoTracked = Boolean(requestedId && requestedId !== bestId) || !requestedId;
    }
  }

  const keyInfo = resolveJevApiKey();
  return {
    ok: true,
    apiKeyConfigured: Boolean(keyInfo.key),
    apiKeyEnvVar: keyInfo.envVar,
    settings,
    conversationId: resolvedConvId || null,
    autoTracked,
    hasData: Boolean(conv && conv.currentTurn),
    currentTurn: conv?.currentTurn || null,
    history: Array.isArray(conv?.history) ? conv.history.slice(0, 10) : [],
    stats: conv?.stats || state.stats || createEmptyStats(),
    globalStats: state.stats || createEmptyStats(),
    updatedAt: conv?.updatedAt || state.updatedAt || null,
  };
}
