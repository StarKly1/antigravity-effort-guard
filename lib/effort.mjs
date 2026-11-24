import fs from 'node:fs';

export const TIER_RANK = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
});

export const TIER_SHORT = Object.freeze({
  low: 'L',
  medium: 'M',
  high: 'H',
});

export const VALID_LEVELS = new Set(['low', 'medium', 'high']);

/**
 * Normalize an effort level string into "low" | "medium" | "high" | null.
 */
export function normalizeEffort(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'low' || v === 'min' || v === 'minimal') return 'low';
  if (v === 'medium' || v === 'med' || v === 'mid') return 'medium';
  if (v === 'high' || v === 'max' || v === 'xhigh') return 'high';
  return null;
}

/**
 * Detect effort tier from a model identifier or display label such as:
 *   "gemini-4-neon-high"
 *   "Gemini 4 Neon (High)"
 *   "claude-sonnet-4-6-medium"
 *   "gemini-3-pro-low"
 */
export function parseEffortFromModelString(modelStr) {
  if (typeof modelStr !== 'string') return null;
  const s = modelStr.trim();
  if (!s || /^auto$/i.test(s)) return null;

  // Match explicit effort tier tokens separated by boundaries / punctuation
  if (/(?:^|[\s_\-(/])(high|xhigh|max)(?:$|[\s_\-)/])/i.test(s)) return 'high';
  if (/(?:^|[\s_\-(/])(medium|med)(?:$|[\s_\-)/])/i.test(s)) return 'medium';
  if (/(?:^|[\s_\-(/])(low|minimal)(?:$|[\s_\-)/])/i.test(s)) return 'low';

  return null;
}

/**
 * Tail-read transcript.jsonl (up to ~64KB) to detect the most recent active model
 * or Model Selection setting change when PreInvocation's modelName is "auto" or lacks a tier.
 */
export function detectEffortFromTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { effort: null, model: null };
  }
  try {
    if (!fs.existsSync(transcriptPath)) return { effort: null, model: null };
    const stat = fs.statSync(transcriptPath);
    const maxBytes = 65536;
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    const fd = fs.openSync(transcriptPath, 'r');
    let chunk = '';
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      chunk = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = chunk.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
          const m = obj.content.match(/Model Selection`?\s+from\s+[^\n]+?\s+to\s+([^.\n<]+)/i);
          if (m && m[1]) {
            const candidate = m[1].trim();
            const effort = parseEffortFromModelString(candidate);
            if (effort) return { effort, model: candidate };
          }
        }
        if (obj.type === 'PLANNER_RESPONSE' && typeof obj.model === 'string') {
          const effort = parseEffortFromModelString(obj.model);
          if (effort) return { effort, model: obj.model };
        }
      } catch {
        // Ignore truncated first line or malformed line
      }
    }
  } catch {
    // Ignore fs errors — fail open
  }
  return { effort: null, model: null };
}

/**
 * Resolve active effort tier from PreInvocation payload + optional transcript fallback.
 */
export function resolveActiveEffort(payload) {
  const rawModel = typeof payload?.modelName === 'string' ? payload.modelName.trim() : '';
  const direct = parseEffortFromModelString(rawModel);
  if (direct) {
    return { effort: direct, model: rawModel };
  }

  const fromTranscript = detectEffortFromTranscript(payload?.transcriptPath);
  if (fromTranscript.effort) {
    return fromTranscript;
  }

  return { effort: null, model: rawModel || null };
}

/**
 * Evaluate Effort Guard policy against a judge verdict.
 *
 * Returns:
 *   {
 *     status: "paused" | "advisory" | "passed",
 *     effectiveLevel: "low" | "medium" | "high",
 *     gap: number,
 *     saveModeCapped: boolean,
 *     estimatedSavedTokensK: number
 *   }
 */
export function evaluatePolicy({
  activeEffort,
  judgeLevel,
  confidence,
  settings,
  quotaPct = null,
}) {
  const cleanJudge = normalizeEffort(judgeLevel) || 'medium';
  const cleanActive = normalizeEffort(activeEffort);
  const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;

  const mode = settings?.mode || 'guard';
  const triggerRule = settings?.triggerRule || 'any';
  const saveMode = Boolean(settings?.saveMode);
  const confThreshold = Number.isFinite(Number(settings?.confThreshold))
    ? Number(settings.confThreshold)
    : 85;

  // Save Mode caps effective recommended effort at Medium when quota >= 80%
  const quotaHigh = typeof quotaPct === 'number' && Number.isFinite(quotaPct) && quotaPct >= 80;
  let effectiveLevel = cleanJudge;
  let saveModeCapped = false;
  if (saveMode && quotaHigh && cleanJudge === 'high') {
    effectiveLevel = 'medium';
    saveModeCapped = true;
  }

  const gap = cleanActive ? TIER_RANK[cleanActive] - TIER_RANK[effectiveLevel] : 0;

  const meetsGap =
    (triggerRule === 'any' && gap >= 1) ||
    (triggerRule === 'two' && gap >= 2) ||
    (triggerRule === 'save' && saveMode && (quotaPct === null || quotaHigh) && gap >= 1);

  const meetsConf = conf >= confThreshold;

  let status = 'passed';
  if (mode === 'guard' && meetsGap && meetsConf) {
    status = 'paused';
  } else if (mode === 'passive' && gap >= 1) {
    status = 'advisory';
  }

  return {
    status,
    effectiveLevel,
    gap,
    saveModeCapped,
    estimatedSavedTokensK: status === 'paused' && gap > 0 ? gap * 6 : 0,
  };
}
