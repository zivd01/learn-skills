/**
 * model-policy-resolver.mjs
 * Applies Stage A (Hard constraints) and Stage B (Weighted scoring)
 * to select primary, fallback, and escalation models from the registry.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fix A6: module-level singleton cache for registry and policy.
// Populated on first call to loadConfigs(); subsequent calls return the cached object.
// Cache is intentionally NOT invalidated between calls — the files are static at runtime.
// Tests that mutate registry.yaml must re-import this module with a cache-busting query string
// (e.g. `import('...model-policy-resolver.mjs?v=' + Date.now())`) to bypass the cache.
let _configCache = null;

/**
 * A simple line-by-line YAML parser designed for parsing our specific model registry
 * and policy files. It supports indentation maps and lists.
 */
export function parseYaml(content) {
  const lines = content.split(/\r?\n/);
  const result = {};
  const stack = []; // Stack of { indent, ref } — ref is the current object or array

  // Fix #1: iterate by index so peekNextLineIsList receives the correct offset
  // regardless of duplicate line content.
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let line = lines[lineIdx];

    // Strip trailing comments (unless inside quotes)
    const commentIdx = line.indexOf('#');
    if (commentIdx !== -1) {
      const beforeComment = line.slice(0, commentIdx);
      const quoteCount = (beforeComment.match(/['"]/g) || []).length;
      if (quoteCount % 2 === 0) {
        line = beforeComment;
      }
    }

    const trimmed = line.trim();
    if (!trimmed) continue; // Skip blank lines

    // Determine indentation level
    const indent = line.search(/\S/);

    // Pop stack until we find a parent with strictly less indentation
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    // Determine parent context
    let parent = stack.length > 0 ? stack[stack.length - 1].ref : result;

    if (trimmed.startsWith('-')) {
      // Block sequence item
      const valStr = trimmed.slice(1).trim();
      const parsedVal = parseValue(valStr);
      if (Array.isArray(parent)) {
        parent.push(parsedVal);
      }
    } else if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      const valStr = trimmed.slice(colonIdx + 1).trim();

      if (valStr === '') {
        // Map or sequence header — peek at the next non-blank line to decide
        // Fix #1: pass lineIdx + 1 (numeric index), not the string-searched index
        const isList = peekNextLineIsList(lines, lineIdx + 1);
        const childRef = isList ? [] : {};

        if (Array.isArray(parent)) {
          parent.push({ [key]: childRef });
        } else {
          parent[key] = childRef;
        }

        stack.push({ indent, key, ref: childRef });
      } else {
        // Fix #8: handle flow sequences: key: [a, b, c]
        if (valStr.startsWith('[') && valStr.endsWith(']')) {
          const items = valStr.slice(1, -1).split(',').map(s => parseValue(s.trim())).filter(v => v !== null || valStr.includes('null'));
          if (Array.isArray(parent)) {
            parent.push({ [key]: items });
          } else {
            parent[key] = items;
          }
        } else {
          // Simple key-value
          const parsedVal = parseValue(valStr);
          if (Array.isArray(parent)) {
            parent.push({ [key]: parsedVal });
          } else {
            parent[key] = parsedVal;
          }
        }
      }
    }
  }

  return result;
}

// Fix #1: receives a numeric startIdx — no string search needed
function peekNextLineIsList(lines, startIdx) {
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed.startsWith('-');
  }
  return false;
}

function parseValue(valStr) {
  if (!valStr) return null;
  if (valStr === 'true') return true;
  if (valStr === 'false') return false;
  if (valStr === 'null' || valStr === '~') return null;
  // Fix A7: removed dead `unknown` guard — plain strings fall through to the return below anyway.
  // The guard was misleading: it implied 'unknown' needed special handling, but any unquoted
  // non-numeric string is already returned as-is. Removing it makes the parser more honest.

  // Quoted string
  if ((valStr.startsWith('"') && valStr.endsWith('"')) || (valStr.startsWith("'") && valStr.endsWith("'"))) {
    return valStr.slice(1, -1);
  }

  // Fix A7: guard against scientific-notation or unit-suffixed strings being misread as numbers.
  // Only treat a value as a number if it looks like a plain integer or decimal (no letters).
  if (/^-?\d+(\.\d+)?$/.test(valStr)) {
    return Number(valStr);
  }

  return valStr;
}

/**
 * Loads and parses registry and policy files.
 * Fix A6: returns a cached result after the first call to avoid repeated disk reads.
 * Pass { bust: true } to force a fresh read (used by tests that mutate the files).
 */
export function loadConfigs({ bust = false } = {}) {
  if (_configCache && !bust) return _configCache;

  const registryPath = join(__dirname, 'model-registry.yaml');
  const policyPath = join(__dirname, 'model-policy.yaml');

  let registry = { models: {} };
  let policies = { quality_first: {}, balanced: {}, cost_first: {} };

  if (existsSync(registryPath)) {
    registry = parseYaml(readFileSync(registryPath, 'utf8'));
  }
  if (existsSync(policyPath)) {
    policies = parseYaml(readFileSync(policyPath, 'utf8'));
  }

  _configCache = { registry, policies };
  return _configCache;
}

/** Clears the config cache — call in tests that write to registry/policy files. */
export function clearConfigCache() {
  _configCache = null;
}

/**
 * Resolves appropriate models based on task classification.
 * @param {object} taskAnalysis
 * @param {{ bust?: boolean }} [opts]  opts.bust=true forces a fresh registry read (for tests)
 */
export function resolveModels(taskAnalysis, { bust = false } = {}) {
  const { registry, policies } = loadConfigs({ bust });

  const models = registry.models || {};
  const policyName = taskAnalysis.optimization_policy || "balanced";
  const policyWeights = policies[policyName] || {
    quality: 20,
    reasoning: 15,
    security_and_residency: 20,
    tool_compatibility: 15,
    reliability: 10,
    cost: 10,
    latency: 10
  };

  // Validate policy weights total exactly 100
  const totalWeight = Object.values(policyWeights).reduce((sum, w) => sum + (Number(w) || 0), 0);
  if (Math.round(totalWeight) !== 100) {
    throw new Error(`Policy weights for "${policyName}" do not total exactly 100 (got ${totalWeight})`);
  }

  const candidates = [];

  // Stage A: Hard Constraints
  for (const [id, m] of Object.entries(models)) {
    const disqualifications = [];

    // 1. Enabled & Approved
    if (m.enabled !== true) disqualifications.push("MODEL_DISABLED");
    if (m.approved !== true) disqualifications.push("MODEL_NOT_APPROVED");

    // 2. Airgap check
    if (taskAnalysis.constraints.air_gapped && m.governance?.air_gap_compatible !== true) {
      disqualifications.push("AIR_GAP_INCOMPATIBLE");
    }

    // 3. External processing forbidden
    // Fix #3: null/undefined external_processing is treated as "potentially external" and
    // disqualifies the model in restricted envs — because null !== false satisfies the condition.
    if (!taskAnalysis.constraints.external_processing_allowed && m.governance?.external_processing !== false) {
      disqualifications.push("EXTERNAL_PROCESSING_FORBIDDEN");
    }

    // 4. Data classification approved classes
    const approvedClasses = m.governance?.approved_data_classes || [];
    if (!approvedClasses.includes(taskAnalysis.data_classification)) {
      disqualifications.push("DATA_CLASSIFICATION_NOT_APPROVED");
    }

    // 5. Tool calling requirements
    if (taskAnalysis.required_capabilities.tool_calling && m.capabilities?.tool_calling !== true) {
      disqualifications.push("MISSING_TOOL_CALLING_SUPPORT");
    }
    if (taskAnalysis.required_capabilities.structured_output && m.capabilities?.structured_output !== true) {
      disqualifications.push("MISSING_STRUCTURED_OUTPUT_SUPPORT");
    }

    // 6. Vision requirements
    if (taskAnalysis.required_capabilities.vision && m.capabilities?.vision !== true) {
      disqualifications.push("MISSING_VISION_SUPPORT");
    }

    // 7. Context window requirements
    const taskMinTokens = taskAnalysis.required_capabilities.minimum_context_tokens || 4096;
    const modelMaxTokens = m.capabilities?.context_tokens || 0;
    if (modelMaxTokens < taskMinTokens) {
      disqualifications.push("INSUFFICIENT_CONTEXT_WINDOW");
    }

    // 8. Reasoning level match
    const reqReasoning = taskAnalysis.required_capabilities.reasoning || "low";
    const modelReasoning = m.capabilities?.reasoning || "low";
    if (reqReasoning === "high" && modelReasoning !== "high") {
      disqualifications.push("INSUFFICIENT_REASONING_LEVEL");
    } else if (reqReasoning === "medium" && modelReasoning === "low") {
      disqualifications.push("INSUFFICIENT_REASONING_LEVEL");
    }

    // 9. Production change approval
    if (taskAnalysis.production_impact && m.governance?.production_approved !== true) {
      disqualifications.push("PRODUCTION_NOT_APPROVED");
    }

    // 12. Version policy safety — Fix A2: floating version_policy is unsafe for governed environments.
    // A model with version_policy: floating can change silently between selection and execution.
    // Disqualify when the task has production_impact OR data_classification is confidential/restricted.
    const isHighStakes = taskAnalysis.production_impact ||
      taskAnalysis.data_classification === 'confidential' ||
      taskAnalysis.data_classification === 'restricted';
    if (isHighStakes && m.version_policy === 'floating') {
      disqualifications.push("FLOATING_VERSION_UNSAFE");
    }

    // 10. Health status check
    // Fix #2: also disqualify models with unknown health — only "healthy" is accepted
    if (m.operational?.health_status !== "healthy") {
      disqualifications.push("MODEL_UNHEALTHY");
    }

    // 11. Credentials safety check (No secrets in registry)
    const mStr = JSON.stringify(m);
    const hasSecrets = mStr.match(/(api[_-]?key|password|token|secret)[a-zA-Z0-9_\-\s]*[:=]\s*["'][A-Za-z0-9+/_\-]{20,}/i) || mStr.match(/sk-[a-zA-Z0-9_\-]{20,}/i);
    if (hasSecrets) {
      disqualifications.push("SECURITY_CREDENTIALS_LEAK");
    }

    const passed = disqualifications.length === 0;

    candidates.push({
      id,
      passed,
      disqualifications,
      model: m
    });
  }

  // Filter candidates that passed all hard constraints
  const passedCandidates = candidates.filter(c => c.passed);

  // Stage B: Weighted Scoring
  const scoredCandidates = passedCandidates.map(c => {
    const m = c.model;

    // Normalize category scores between 0 and 10
    const catScores = {};

    // 1. Quality (composite of registry coding and reasoning)
    const codingScore = m.capabilities?.coding === "high" ? 10 : m.capabilities?.coding === "medium" ? 6 : m.capabilities?.coding === "low" ? 3 : 0;
    const reasoningScore = m.capabilities?.reasoning === "high" ? 10 : m.capabilities?.reasoning === "medium" ? 6 : m.capabilities?.reasoning === "low" ? 3 : 1;
    catScores.quality = (codingScore + reasoningScore) / 2;

    // 2. Reasoning
    catScores.reasoning = reasoningScore;

    // 3. Security and residency
    let secScore = 5.0; // Base neutral
    if (m.governance?.external_processing === false) secScore += 2.0; // Preferred local
    if (m.governance?.air_gap_compatible === true) secScore += 1.0;
    if (m.version_policy === "pinned") secScore += 2.0; // Pinned is safer
    catScores.security_and_residency = Math.min(10, secScore);

    // 4. Tool compatibility
    let toolScore = 0.0;
    if (m.capabilities?.tool_calling) toolScore += 5.0;
    if (m.capabilities?.tool_choice) toolScore += 5.0;
    catScores.tool_compatibility = toolScore;

    // 5. Reliability
    catScores.reliability = typeof m.operational?.reliability_score === "number"
      ? m.operational.reliability_score * 10
      : 5.0; // neutral default

    // 6. Cost (inverse of token prices)
    const inCost = m.economics?.input_cost_per_token;
    const outCost = m.economics?.output_cost_per_token;
    if (inCost === null || outCost === null || inCost === undefined || outCost === undefined) {
      catScores.cost = 5.0; // neutral default
    } else {
      // Map cost: cheaper models get higher scores
      const avgCostMillion = ((inCost + outCost) / 2) * 1_000_000;
      catScores.cost = Math.max(0, Math.min(10, 10 - (avgCostMillion / 5))); // Scale normalized to 10
    }

    // 7. Latency
    // Fix #5: scale normalized to realistic registry range (50–2000ms).
    // Formula: score = 10 * (1 - (latency - MIN) / (MAX - MIN))
    // With MIN=50, MAX=2000: lower latency → higher score, clamped [0, 10].
    const latency = m.operational?.latency_score;
    if (latency === null || latency === undefined) {
      catScores.latency = 5.0; // neutral default
    } else {
      const LATENCY_MIN = 50;
      const LATENCY_MAX = 2000;
      catScores.latency = Math.max(0, Math.min(10, 10 * (1 - (latency - LATENCY_MIN) / (LATENCY_MAX - LATENCY_MIN))));
    }

    // Multiply by policy weights
    let totalScore = 0;
    for (const [cat, weight] of Object.entries(policyWeights)) {
      totalScore += (catScores[cat] || 0) * weight;
    }
    totalScore = totalScore / 100; // Normalized total score

    // Selection reason codes
    const reason_codes = [];
    if (m.governance?.external_processing === false) reason_codes.push("LOCAL_EXECUTION_SAFE");
    if (m.capabilities?.reasoning === "high") reason_codes.push("HIGH_REASONING_CAPABLE");
    if (m.capabilities?.coding === "high") reason_codes.push("HIGH_CODING_CAPABLE");

    return {
      id: c.id,
      passed: true,
      category_scores: catScores,
      total_score: totalScore,
      disqualifications: [],
      reason_codes,
      model: m
    };
  });

  // Tie-breaking sorting order
  scoredCandidates.sort((a, b) => {
    // 1. Total score (descending)
    if (Math.abs(b.total_score - a.total_score) > 0.0001) {
      return b.total_score - a.total_score;
    }
    // 2. Better security and governance match
    if (b.category_scores.security_and_residency !== a.category_scores.security_and_residency) {
      return b.category_scores.security_and_residency - a.category_scores.security_and_residency;
    }
    // 3. Better task capability match (quality)
    if (b.category_scores.quality !== a.category_scores.quality) {
      return b.category_scores.quality - a.category_scores.quality;
    }
    // 4. Better historical validation result / reliability
    if (b.category_scores.reliability !== a.category_scores.reliability) {
      return b.category_scores.reliability - a.category_scores.reliability;
    }
    // 5. Lower expected cost (higher cost score)
    if (b.category_scores.cost !== a.category_scores.cost) {
      return b.category_scores.cost - a.category_scores.cost;
    }
    // 6. Lower expected latency (higher latency score)
    if (b.category_scores.latency !== a.category_scores.latency) {
      return b.category_scores.latency - a.category_scores.latency;
    }
    // 7. Stable lexical ordering of profile identifier
    return a.id.localeCompare(b.id);
  });

  // Select Primary, Fallback, Escalation
  const primary = scoredCandidates[0] ? scoredCandidates[0].id : null;
  const fallback = scoredCandidates[1] ? scoredCandidates[1].id : primary;
  let escalation = null;

  // Escalation selection: find the first model with higher reasoning capability if available, or the highest scored model
  if (scoredCandidates.length > 2) {
    const higherReasoning = scoredCandidates.find(c => c.model.capabilities?.reasoning === "high" && c.id !== primary);
    escalation = higherReasoning ? higherReasoning.id : scoredCandidates[2].id;
  } else if (scoredCandidates.length === 2) {
    escalation = scoredCandidates[1].id;
  } else {
    escalation = primary;
  }

  return {
    primary,
    fallback,
    escalation,
    candidates: scoredCandidates,
    all_candidates_status: candidates.map(c => ({
      id: c.id,
      passed: c.passed,
      disqualifications: c.disqualifications
    }))
  };
}
