/**
 * model-task-classifier.mjs
 * Analyzes the complete task context (heuristically and deterministically)
 * to classify the task type, complexity, risk level, and required model capabilities.
 */

export function classifyTask(context = {}) {
  const prompt = context.prompt || "";
  const skills = context.skills || [];
  const files = context.files || [];
  const requiredTools = context.required_tools || [];
  const optimizationPreference = context.optimization_preference || "balanced";
  const env = context.env || {};

  const reason_codes = [];
  let task_type = "general";
  let task_subtype = "general_assistance";
  let complexity = "low";
  let risk_level = "low";
  let data_classification = "public";
  let production_impact = false;

  const required_capabilities = {
    reasoning: "low",
    coding: "none",
    tool_calling: false,
    structured_output: false,
    long_context: false,
    minimum_context_tokens: 4096,
    vision: false,
    multilingual: false
  };

  const constraints = {
    external_processing_allowed: true,
    air_gapped: false,
    approved_providers_only: true,
    human_approval_required: false
  };

  // Heuristic scan patterns
  const p = prompt.toLowerCase();

  // 1. Airgap detection
  const isAirGapped = p.includes("airgap") || p.includes("air-gap") || p.includes("offline") || p.includes("disconnected") || env.AIR_GAPPED === "true" || env.AIR_GAPPED === true;
  if (isAirGapped) {
    constraints.air_gapped = true;
    constraints.external_processing_allowed = false;
    reason_codes.push("AIR_GAPPED_ENVIRONMENT");
  }

  // 2. Data classification check
  const isConfidential = p.includes("confidential") || p.includes("restricted") || p.includes("private data") || p.includes("pii") || p.includes("ssn") || p.includes("gdpr");
  if (isConfidential) {
    data_classification = p.includes("restricted") ? "restricted" : "confidential";
    constraints.external_processing_allowed = false;
    reason_codes.push("CONFIDENTIAL_DATA");
  }

  // 3. Security, auth and credentials
  const isSecurity = p.includes("auth") || p.includes("login") || p.includes("jwt") || p.includes("oauth") || p.includes("credential") || p.includes("password") || p.includes("security-review") || p.includes("vulnerab") || skills.includes("security-review");

  // 4. Production, databases and infra
  const isProduction = p.includes("production") || p.includes("deploy") || p.includes("kubernetes") || p.includes("terraform") || p.includes("pipeline") || p.includes("ci/cd") || p.includes("main branch");
  const isDatabase = p.includes("database") || p.includes("migration") || p.includes("db2") || p.includes("postgres") || p.includes("sql schema");

  // 5. Coding & Refactoring
  const isCoding = p.includes("implement") || p.includes("write") || p.includes("code") || p.includes("function") || p.includes("bug") || p.includes("fix") || p.includes("refactor") || files.some(f => /\.(js|mjs|ts|py|go|java|cpp|c|cs)$/i.test(f));

  // Fix A3: apply task_type and capabilities in explicit priority order, not by block sequence.
  // Priority (highest → lowest): security > db > infra > coding > general
  // Each level only applies what it uniquely owns; shared fields (risk, reasoning) are merged after.
  if (isSecurity) {
    task_type = "security";
    task_subtype = p.includes("auth") || p.includes("login") ? "authentication" : "vulnerability_scan";
    complexity = "high";
    risk_level = "high";
    required_capabilities.reasoning = "high";
    required_capabilities.coding = "high";
    reason_codes.push("HIGH_SECURITY_RISK");
    if (p.includes("auth") || p.includes("login")) {
      reason_codes.push("AUTHORIZATION_LOGIC");
    }
  }

  // db/infra always marks production_impact regardless of security flag
  if (isDatabase) {
    // Only override task_type when security didn't claim it — but always set production fields
    if (task_type !== "security") {
      task_type = "db";
      task_subtype = "migration";
      complexity = "high";
      risk_level = "high";
    }
    production_impact = true;
    required_capabilities.reasoning = "high";
    required_capabilities.coding = required_capabilities.coding === "high" ? "high" : "medium";
    reason_codes.push("PRODUCTION_CHANGE");
    reason_codes.push("DB_MIGRATION");
  } else if (isProduction) {
    if (task_type !== "security" && task_type !== "db") {
      task_type = "infra";
      task_subtype = "deployment";
      complexity = "high";
      risk_level = "high";
    }
    production_impact = true;
    required_capabilities.reasoning = "high";
    required_capabilities.coding = "high";
    reason_codes.push("PRODUCTION_CHANGE");
  }

  if (isCoding && task_type === "general") {
    task_type = p.includes("bug") || p.includes("fix") ? "bugfix" : "feature";
    task_subtype = p.includes("refactor") ? "refactoring" : "code_generation";
    required_capabilities.coding = "medium";
    required_capabilities.reasoning = "medium";
    if (p.includes("refactor") && p.includes("repo")) {
      complexity = "high";
      risk_level = "medium";
      required_capabilities.coding = "high";
      required_capabilities.reasoning = "high";
      reason_codes.push("REPO_WIDE_REFACTOR");
    }
  }

  // 6. Tool calling
  if (requiredTools.length > 0 || p.includes("execute_command") || p.includes("run command") || p.includes("shell")) {
    required_capabilities.tool_calling = true;
    reason_codes.push("TOOL_CALLING_REQUIRED");
  }

  // 7. Vision
  const isVision = p.includes("image") || p.includes("png") || p.includes("jpg") || p.includes("jpeg") || p.includes("diagram") || p.includes("multimodal") || p.includes("vision");
  if (isVision) {
    required_capabilities.vision = true;
    reason_codes.push("VISION_REQUIRED");
  }

  // 8. Long Context
  const approxTokens = Math.ceil(prompt.length / 3) + (files.length * 1000);
  if (approxTokens > 8000 || p.includes("long context") || p.includes("large file") || p.includes("entire repo")) {
    required_capabilities.long_context = true;
    required_capabilities.minimum_context_tokens = Math.max(16384, approxTokens);
    reason_codes.push("LONG_CONTEXT_REQUIRED");
  } else {
    required_capabilities.minimum_context_tokens = Math.max(4096, approxTokens);
  }

  // 9. Compliance & Regulation
  const isCompliance = p.includes("compliance") || p.includes("audit") || p.includes("regulated") || p.includes("gxml") || p.includes("hipaa") || p.includes("pci");
  if (isCompliance) {
    required_capabilities.reasoning = "high";
    reason_codes.push("COMPLIANCE_RELATED");
    risk_level = risk_level === "low" ? "medium" : risk_level;
  }

  // 10. Formatting (Low Risk)
  const isFormatting = p.includes("format") || p.includes("prettier") || p.includes("style") || p.includes("lint") || p.includes("indent");
  if (isFormatting && risk_level === "low") {
    reason_codes.push("LOW_RISK_FORMATTING");
    task_subtype = "styling_and_formatting";
  }

  // Low confidence & ambiguity checks
  let confidence = 0.9;
  if (prompt.length < 30) {
    confidence = 0.5;
    reason_codes.push("AMBIGUOUS_REQUIREMENTS");
    reason_codes.push("LOW_CLASSIFICATION_CONFIDENCE");
  }

  // Set overall risk levels based on specific triggers
  if (risk_level === "high" || risk_level === "critical") {
    required_capabilities.reasoning = "high";
  }

  // Human approval requirement conditions
  if (
    risk_level === "critical" ||
    (risk_level === "high" && production_impact) ||
    (confidence < 0.7 && (isSecurity || isProduction || isDatabase))
  ) {
    constraints.human_approval_required = true;
    reason_codes.push("HUMAN_APPROVAL_REQUIRED");
  }

  // Determine optimization policy
  let optimization_policy = optimizationPreference;
  if (risk_level === "high" || risk_level === "critical" || isSecurity || isProduction || isCompliance) {
    optimization_policy = "quality_first";
  } else if (isFormatting) {
    optimization_policy = "cost_first";
  }

  return {
    task_type,
    task_subtype,
    complexity,
    risk_level,
    data_classification,
    production_impact,
    required_capabilities,
    constraints,
    optimization_policy,
    confidence,
    reason_codes: [...new Set(reason_codes)] // Deduplicate
  };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("model-task-classifier.mjs")) {
  try {
    const inputRaw = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    const result = classifyTask(inputRaw);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}
