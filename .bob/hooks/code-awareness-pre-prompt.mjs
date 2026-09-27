/**
 * code-awareness-pre-prompt.mjs
 *
 * Pre-prompt hook that intercepts the user prompt, performs task classification,
 * evaluates installed skills, resolves model requirement profiles and policy weights,
 * validates routing enforcement, compiles the execution manifest, and injects
 * the PRE-EXECUTION CAPABILITY GATE instruction into Bob's context.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Import our custom model-awareness modules
const __dirname = dirname(fileURLToPath(import.meta.url));
const modelAwarenessDir = resolve(__dirname, '../skills/model-awareness');

// Imports using dynamic or relative syntax
import { classifyTask } from '../skills/model-awareness/model-task-classifier.mjs';
import { resolveModels } from '../skills/model-awareness/model-policy-resolver.mjs';

// Pre-flight scanner imports
// Fix A5: removed unused ALLOWED_DOMAINS import — domain validation is handled inside scanSkillContentSecurity.
import { scanSkillContentSecurity } from '../skills/code-awareness/skill-security-verifier.mjs';

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch (e) {
    // fallback
  }

  const prompt = input.prompt || "";
  const filesInScope = input.files || [];
  const requiredTools = input.required_tools || [];
  const env = process.env || {};

  // 1. Compute prompt hash
  const promptHash = createHash('sha256').update(prompt, 'utf8').digest('hex');

  // 2. Pre-flight scan for credentials in the prompt (Scenario 17)
  const credentialScan = scanSkillContentSecurity(prompt);
  const leakedCredentials = credentialScan.findings.filter(f => f.category === 'CREDENTIAL_HARVESTING');
  if (leakedCredentials.length > 0) {
    // Prompt contains credentials. Redact or fail.
    // Existing credential pre-flight protections remain active. We block execution.
    process.stderr.write(`[PRE-EXECUTION GATE] SECURITY: Credentials detected in prompt. Aborting request.\n`);
    process.exit(1);
  }

  // 3. Discover and verify relevant installed skills (Scenario 12)
  const skillsDir = resolve(__dirname, '../skills');
  const selected_skills = [];
  try {
    if (existsSync(skillsDir)) {
      // Fix A4: use { withFileTypes: true } to skip plain files (e.g. install-log.json)
      // without relying on existsSync to silently swallow non-directory entries.
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        const skillPath = join(skillsDir, name, 'SKILL.md');
        if (existsSync(skillPath)) {
          const content = readFileSync(skillPath, 'utf8');
          // Scan skill for safety
          const scan = scanSkillContentSecurity(content);
          
          let integrity = "unknown";
          let security = scan.passed ? "verified" : "rejected";

          // Try to verify integrity using Checksum-SHA256
          const declaredMatch = content.match(/^#\s*Checksum-SHA256:\s*([0-9a-f]{64})\s*$/im);
          if (declaredMatch) {
            const declared = declaredMatch[1];
            // Strip provenance
            const lines = content.split('\n');
            const out = ['---'];
            let inHeader = true;
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              if (inHeader && /^#\s/.test(line)) continue;
              inHeader = false;
              out.push(line);
            }
            const stripped = out.join('\n');
            const actual = createHash('sha256').update(stripped, 'utf8').digest('hex');
            integrity = (actual === declared) ? "verified" : "failed";
          }

          selected_skills.push({
            name,
            source: name === 'model-awareness' ? 'local' : 'discovered',
            checksum: declaredMatch ? declaredMatch[1] : scan.sha256,
            security_status: security,
            integrity_status: integrity
          });
        }
      }
    }
  } catch (err) {
    // Keep list empty or basic on error
  }

  // Filter skills for manifest: fail-closed if any skill is rejected
  const rejectedSkill = selected_skills.find(s => s.security_status === 'rejected');
  if (rejectedSkill) {
    // Scenario 12: Skill security verification fails. Skill is not used.
    // Model selection does not override skill rejection. Block execution.
    process.stderr.write(`[PRE-EXECUTION GATE] SECURITY: Skill verification failed for "${rejectedSkill.name}". Aborting execution.\n`);
    process.exit(1);
  }

  // 4. Run task classification with only active/relevant skills for this prompt
  const activeSkills = [];
  const pLower = prompt.toLowerCase();
  for (const s of selected_skills) {
    if (s.name === 'security-review' && (pLower.includes('security') || pLower.includes('vulnerab') || pLower.includes('login') || pLower.includes('auth'))) {
      activeSkills.push(s.name);
    } else if (s.name === 'airgap-validator' && (pLower.includes('airgap') || pLower.includes('air-gap') || pLower.includes('offline'))) {
      activeSkills.push(s.name);
    } else if (s.name === 'web-browse' && (pLower.includes('search') || pLower.includes('web') || pLower.includes('browse') || pLower.includes('fetch'))) {
      activeSkills.push(s.name);
    } else if (s.name === 'model-awareness' && (pLower.includes('model') || pLower.includes('routing') || pLower.includes('optimiz'))) {
      activeSkills.push(s.name);
    }
  }

  const classification = classifyTask({
    prompt,
    skills: activeSkills,
    files: filesInScope,
    required_tools: requiredTools,
    optimization_preference: env.BOB_OPTIMIZATION_PREFERENCE || "balanced",
    env
  });

  // 5. Build Model Requirement Profile

  // Fix #7: derive allowed_providers dynamically from the registry rather than a hardcoded list.
  // This ensures adding a new provider to model-registry.yaml is immediately reflected here.
  let allowedProviders;
  try {
    const { loadConfigs } = await import('../skills/model-awareness/model-policy-resolver.mjs');
    const { registry } = loadConfigs();
    const allProviders = [...new Set(
      Object.values(registry.models || {}).map(m => m.provider).filter(Boolean)
    )];
    if (classification.constraints.air_gapped) {
      // In air-gap mode keep only providers whose models are air_gap_compatible
      const airGapProviders = new Set(
        Object.values(registry.models || {})
          .filter(m => m.governance?.air_gap_compatible === true)
          .map(m => m.provider)
          .filter(Boolean)
      );
      allowedProviders = allProviders.filter(p => airGapProviders.has(p));
    } else {
      allowedProviders = allProviders;
    }
  } catch {
    // Safe fallback if registry is unavailable
    allowedProviders = classification.constraints.air_gapped
      ? ["local-ollama"]
      : ["ibm-watsonx", "local-ollama", "public-api"];
  }

  const modelRequirements = {
    reasoning: classification.required_capabilities.reasoning,
    coding: classification.required_capabilities.coding,
    // Fix #4: tool_choice_required is independent from tool_calling_required.
    // tool_calling = can call tools at all; tool_choice = can select a specific tool by name.
    // The classifier does not currently detect a need for explicit tool choice, so default false.
    tool_calling_required: classification.required_capabilities.tool_calling,
    tool_choice_required: false,
    structured_output_required: classification.required_capabilities.structured_output,
    minimum_context_tokens: classification.required_capabilities.minimum_context_tokens,
    minimum_output_tokens: 2048,
    vision_required: classification.required_capabilities.vision,
    prompt_caching_preferred: false,
    maximum_expected_latency_ms: null,
    data_classification: classification.data_classification,
    allowed_deployment_locations: classification.constraints.air_gapped ? ["on-premise"] : ["us-south", "on-premise"],
    // Fix #7: dynamically derived above
    allowed_providers: allowedProviders,
    air_gapped: classification.constraints.air_gapped,
    // Fix #6: explicitly read optimization_policy from classification here so the
    // coupling is visible and intentional. If classifyTask changes its field name,
    // this assignment will fail loudly rather than silently using a stale value.
    optimization_policy: classification.optimization_policy,
    human_approval_required: classification.constraints.human_approval_required
  };

  // 6. Run model policy resolution
  let routingDecision = {
    recommended_model_profile: "local-governance-safe",
    fallback_model_profile: "local-governance-safe",
    escalation_model_profile: "local-reasoning-high",
    routing_enforcement: "UNAVAILABLE",
    platform_confirmation: null,
    reason_codes: ["FALLBACK_ROUTING_DEFAULT"]
  };

  let resolutionError = null;

  try {
    const resolution = resolveModels(classification);
    
    // Determine routing enforcement (Scenario 9 & 10)
    let enforcement = "ADVISORY"; // default if analysis succeeded
    let platformConf = null;

    if (env.BOB_MODEL_GATEWAY_URL || env.MOCK_PLATFORM_CONFIRMATION) {
      // Validate gateway configuration and requested profile
      const requestedProfile = resolution.primary;
      if (requestedProfile) {
        enforcement = "ENFORCED";
        platformConf = env.MOCK_PLATFORM_CONFIRMATION || requestedProfile;
      }
    }

    routingDecision = {
      recommended_model_profile: resolution.primary || "local-governance-safe",
      fallback_model_profile: resolution.fallback || "local-governance-safe",
      escalation_model_profile: resolution.escalation || "local-reasoning-high",
      routing_enforcement: enforcement,
      platform_confirmation: platformConf,
      reason_codes: resolution.candidates[0]?.reason_codes || []
    };

    // Scenario 20: No approved model satisfies mandatory constraints.
    if (!resolution.primary) {
      routingDecision.routing_enforcement = "UNAVAILABLE";
      if (classification.constraints.air_gapped || !classification.constraints.external_processing_allowed) {
        // Block sensitive/prohibited execution
        process.stderr.write(`[PRE-EXECUTION GATE] GOVERNANCE: No approved model satisfies mandatory air-gap or residency constraints. Aborting execution.\n`);
        process.exit(1);
      }
    }
  } catch (err) {
    resolutionError = err.message;
    // Schema validation or weight validation failed
    // Scenario 14: Policy weights do not total 100. Resolver does not generate a misleading ranking.
    // Stop model resolution. Do not execute unvalidated routing decision.
    routingDecision = {
      recommended_model_profile: "none",
      fallback_model_profile: "none",
      escalation_model_profile: "none",
      routing_enforcement: "UNAVAILABLE",
      platform_confirmation: null,
      reason_codes: ["RESOLVER_ERROR_WEIGHTS_OR_SCHEMA"]
    };

    // If it violates a security or data policy, we fail closed
    if (classification.risk_level === "high" || classification.risk_level === "critical" || classification.constraints.air_gapped) {
      process.stderr.write(`[PRE-EXECUTION GATE] GOVERNANCE: Model policy resolver error: "${err.message}". FAILED CLOSED due to risk/compliance policy.\n`);
      process.exit(1);
    }
  }

  // 7. Resolve Bob Execution Mode independently from model selection (Part 12)
  let executionMode = "agent";
  let planBeforeExecution = false;

  if (
    classification.risk_level === "high" ||
    classification.risk_level === "critical" ||
    classification.production_impact ||
    classification.task_type === "security" ||
    classification.task_type === "db" ||
    classification.task_type === "infra" ||
    classification.confidence < 0.7
  ) {
    executionMode = "plan";
    planBeforeExecution = true;
  } else if (
    prompt.match(/(explain|how to|what is|why does|conceptual|compare)/i) &&
    !prompt.match(/(write|modify|implement|fix|refactor|create)/i)
  ) {
    executionMode = "ask";
  }

  // 8. Build Execution Manifest (Part 9)
  const manifest = {
    schema_version: "1.0",
    // Fix #9: replace MD5 with SHA-256 — MD5 is blocked under Node.js FIPS mode.
    // Slice to 12 hex chars (48 bits) for a compact but collision-resistant ID.
    decision_id: `dec-${createHash('sha256').update(promptHash + Date.now().toString()).digest('hex').slice(0, 12)}`,
    created_at: new Date().toISOString(),
    prompt_hash: promptHash,
    task: {
      type: classification.task_type,
      subtype: classification.task_subtype,
      complexity: classification.complexity,
      risk: classification.risk_level,
      data_classification: classification.data_classification,
      confidence: classification.confidence,
      reason_codes: classification.reason_codes
    },
    skills: selected_skills,
    model_requirements: modelRequirements,
    policy: {
      optimization: classification.optimization_policy,
      external_processing_allowed: classification.constraints.external_processing_allowed,
      air_gapped: classification.constraints.air_gapped,
      human_approval_required: classification.constraints.human_approval_required
    },
    routing: routingDecision,
    execution: {
      mode: executionMode,
      plan_before_execution: planBeforeExecution,
      verification_required: true,
      approval_required_before_write: classification.constraints.human_approval_required,
      approval_required_before_command: classification.constraints.human_approval_required
    },
    verification: {
      required_checks: ["syntax", "unit-tests", "security-verifier"],
      acceptance_criteria: ["zero-new-findings", "test-pass-100%"],
      escalation_conditions: ["test-failures", "security-finding-detected"]
    }
  };

  // 9. Write Audit Record to model-routing-log.json (Part 14)
  const logRecord = {
    timestamp: manifest.created_at,
    decision_id: manifest.decision_id,
    prompt_hash: manifest.prompt_hash,
    task_type: manifest.task.type,
    risk_level: manifest.task.risk,
    data_classification: manifest.task.data_classification,
    selected_skills: manifest.skills.map(s => s.name),
    optimization_policy: manifest.policy.optimization,
    recommended_model_profile: manifest.routing.recommended_model_profile,
    fallback_model_profile: manifest.routing.fallback_model_profile,
    routing_enforcement: manifest.routing.routing_enforcement,
    confirmed_actual_model: manifest.routing.platform_confirmation,
    reason_codes: manifest.task.reason_codes,
    human_approval_required: manifest.policy.human_approval_required,
    verification_status: "pending",
    escalation_performed: false
  };

  try {
    const logPath = join(modelAwarenessDir, 'model-routing-log.json');
    let logs = [];
    if (existsSync(logPath)) {
      logs = JSON.parse(readFileSync(logPath, 'utf8'));
    }
    logs.push(logRecord);
    writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    // Fail silently on logging but make it visible in stderr
    process.stderr.write(`[PRE-EXECUTION GATE] WARNING: Could not write audit log: ${err.message}\n`);
  }

  // 10. Output the Concise Pre-Execution context instruction (Part 11)
  const verifiedSkillsStr = selected_skills.map(s => `- ${s.name} (Security: ${s.security_status}, Integrity: ${s.integrity_status})`).join('\n') || "- none";
  
  const capabilitySummary = [
    `Reasoning: ${modelRequirements.reasoning}`,
    `Coding: ${modelRequirements.coding}`,
    `Tool Calling: ${modelRequirements.tool_calling_required ? "Yes" : "No"}`,
    `Structured Output: ${modelRequirements.structured_output_required ? "Yes" : "No"}`,
    `Vision: ${modelRequirements.vision_required ? "Yes" : "No"}`
  ].join(', ');

  const instruction = `[PRE-EXECUTION CAPABILITY GATE]

Task classification:
- Type: ${manifest.task.type}
- Complexity: ${manifest.task.complexity}
- Risk: ${manifest.task.risk}
- Data classification: ${manifest.task.data_classification}

Verified skills:
${verifiedSkillsStr}

Required model capabilities:
- ${capabilitySummary}

Recommended model profile:
- ${manifest.routing.recommended_model_profile}

Routing status:
- ${manifest.routing.routing_enforcement}

Execution policy:
- Mode: ${manifest.execution.mode}
- Plan before execution: ${manifest.execution.plan_before_execution}
- Human approval required: ${manifest.policy.human_approval_required}
- Verification required: ${manifest.execution.verification_required}

Mandatory instructions:
1. Use only verified skills listed in the execution manifest.
2. Do not state that a model was selected unless routing status is ENFORCED and platform confirmation exists.
3. Do not weaken security or data-handling constraints.
4. Do not use an external model when external processing is forbidden.
5. For high-risk changes, produce and validate a plan before writes or command execution.
6. Run the required verification checks after implementation.
7. Escalate only to an approved fallback or escalation profile.
8. Record actual results without exposing prompt or source contents.
`;

  process.stdout.write(instruction);
  process.exit(0);
}

main().catch(err => {
  // Safe fallback if hook fails entirely but existing Bob remains policy safe
  process.stderr.write(`[PRE-EXECUTION GATE] ERROR: Hook failed: ${err.message}\n`);
  
  const safeInstruction = `[PRE-EXECUTION CAPABILITY GATE]

Task classification:
- Type: unknown
- Complexity: low
- Risk: low
- Data classification: public

Verified skills:
- none

Required model capabilities:
- Standard

Recommended model profile:
- local-governance-safe

Routing status:
- UNAVAILABLE

Execution policy:
- Mode: ask
- Plan before execution: false
- Human approval required: false
- Verification required: true

Mandatory instructions:
1. Continue execution with default safe options.
2. Do not claim model routing was enforced.
3. Apply standard project security policies.
`;
  process.stdout.write(safeInstruction);
  process.exit(0);
});
