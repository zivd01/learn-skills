import assert from 'node:assert/strict';
import { resolveModels, parseYaml, clearConfigCache } from '../model-policy-resolver.mjs';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = join(__dirname, '..', 'model-registry.yaml');
const policyPath = join(__dirname, '..', 'model-policy.yaml');

export async function run() {
  console.log('Running Model Policy Resolver Tests...');

  // Helper to read the current registry and policy files
  const origRegistryRaw = readFileSync(registryPath, 'utf8');
  const origPolicyRaw = readFileSync(policyPath, 'utf8');

  // Scenario 3: Confidential source code with external processing prohibited
  {
    const taskAnalysis = {
      optimization_policy: 'balanced',
      data_classification: 'restricted', // restricted is confidential
      production_impact: false,
      required_capabilities: {
        reasoning: 'medium',
        coding: 'medium',
        tool_calling: false,
        structured_output: false,
        vision: false,
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: false,
        air_gapped: false
      }
    };

    const resolution = resolveModels(taskAnalysis);
    // Models with external_processing: true must be disqualified.
    // Our local models (local-governance-safe, local-reasoning-high) should be allowed.
    assert.ok(resolution.primary);
    assert.equal(resolution.primary.startsWith('local-'), true);
    
    // Check that enterprise-reasoning-primary (external_processing: true) is disqualified
    const enterpriseModelStatus = resolution.all_candidates_status.find(c => c.id === 'enterprise-reasoning-primary');
    assert.equal(enterpriseModelStatus.passed, false);
    assert.ok(enterpriseModelStatus.disqualifications.includes('EXTERNAL_PROCESSING_FORBIDDEN'));
    console.log('  ✓ Scenario 3: Confidential source code with external processing prohibited passed');
  }

  // Scenario 4: Air-gapped environment
  {
    const taskAnalysis = {
      optimization_policy: 'balanced',
      data_classification: 'public',
      production_impact: false,
      required_capabilities: {
        reasoning: 'medium',
        coding: 'medium',
        tool_calling: false,
        structured_output: false,
        vision: false,
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: false,
        air_gapped: true
      }
    };

    const resolution = resolveModels(taskAnalysis);
    // Only local-governance-safe and local-reasoning-high are airgap compatible
    assert.ok(resolution.primary);
    assert.equal(resolution.primary.startsWith('local-'), true);

    const enterpriseModelStatus = resolution.all_candidates_status.find(c => c.id === 'enterprise-reasoning-primary');
    assert.equal(enterpriseModelStatus.passed, false);
    assert.ok(enterpriseModelStatus.disqualifications.includes('AIR_GAP_INCOMPATIBLE'));
    console.log('  ✓ Scenario 4: Air-gapped environment passed');
  }

  // Scenario 7: Unknown model cost
  {
    // Check that cost is null in 'neutral-unknowns-model' and is not converted to a high score.
    // Note: since Fix #2 neutral-unknowns-model has health_status: unknown and is disqualified
    // at Stage A (MODEL_UNHEALTHY). We verify the cost neutrality via direct registry parse,
    // and confirm the model is correctly rejected rather than silently ranked.
    const registry = parseYaml(origRegistryRaw);
    const unknownModel = registry.models['neutral-unknowns-model'];
    assert.equal(unknownModel.economics.input_cost_per_token, null);
    assert.equal(unknownModel.economics.output_cost_per_token, null);

    const taskAnalysis = {
      optimization_policy: 'balanced',
      data_classification: 'public',
      production_impact: false,
      required_capabilities: {
        reasoning: 'medium',
        coding: 'medium',
        tool_calling: true,
        structured_output: true,
        vision: false,
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: true,
        air_gapped: false
      }
    };

    const resolution = resolveModels(taskAnalysis);
    // Fix #2: neutral-unknowns-model (health_status: unknown) must be disqualified at Stage A
    const status = resolution.all_candidates_status.find(c => c.id === 'neutral-unknowns-model');
    assert.ok(status, 'neutral-unknowns-model must appear in all_candidates_status');
    assert.equal(status.passed, false, 'neutral-unknowns-model must be rejected (unknown health)');
    assert.ok(status.disqualifications.includes('MODEL_UNHEALTHY'), 'Must carry MODEL_UNHEALTHY disqualification');
    console.log('  ✓ Scenario 7: Unknown model cost / unknown health disqualified passed');
  }

  // Scenario 8: Fallback model violates residency policy
  {
    // We can simulate this by setting a residency constraint or data classification constraint.
    // Fallback models must satisfy the same security and governance constraints.
    const taskAnalysis = {
      optimization_policy: 'balanced',
      data_classification: 'restricted',
      production_impact: false,
      required_capabilities: {
        reasoning: 'medium',
        coding: 'medium',
        tool_calling: false,
        structured_output: false,
        vision: false,
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: false,
        air_gapped: false
      }
    };

    const resolution = resolveModels(taskAnalysis);
    // All candidates must satisfy external_processing_allowed: false
    for (const cand of resolution.candidates) {
      assert.equal(cand.model.governance.external_processing, false);
    }
    console.log('  ✓ Scenario 8: Fallback model violates residency policy passed');
  }

  // Scenario 14: Policy weights do not total 100
  {
    // Write invalid policy file temporarily
    const invalidPolicy = `
balanced:
  quality: 10
  reasoning: 10
  security_and_residency: 10
  tool_compatibility: 10
  reliability: 10
  cost: 10
  latency: 10
`;
    try {
      writeFileSync(policyPath, invalidPolicy, 'utf8');
      // Fix A6: bust cache so resolver re-reads the modified policy file
      clearConfigCache();

      const taskAnalysis = {
        optimization_policy: 'balanced',
        data_classification: 'public',
        production_impact: false,
        required_capabilities: {
          reasoning: 'low',
          coding: 'none',
          tool_calling: false,
          structured_output: false,
          vision: false,
          minimum_context_tokens: 4096
        },
        constraints: {
          external_processing_allowed: true,
          air_gapped: false
        }
      };

      assert.throws(() => {
        resolveModels(taskAnalysis);
      }, /do not total exactly 100/);
    } finally {
      // Restore original policy file and clear cache again
      writeFileSync(policyPath, origPolicyRaw, 'utf8');
      clearConfigCache();
    }
    console.log('  ✓ Scenario 14: Policy weights do not total 100 passed');
  }

  // Scenario 18: High-quality model lacks required tool calling
  {
    const taskAnalysis = {
      optimization_policy: 'quality_first',
      data_classification: 'public',
      production_impact: false,
      required_capabilities: {
        reasoning: 'medium',
        coding: 'medium',
        tool_calling: true,
        structured_output: true,
        vision: false,
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: true,
        air_gapped: false
      }
    };

    const resolution = resolveModels(taskAnalysis);
    // cheap-utility-model does not support tool calling, so it must be disqualified
    const cheapModelStatus = resolution.all_candidates_status.find(c => c.id === 'cheap-utility-model');
    assert.equal(cheapModelStatus.passed, false);
    assert.ok(cheapModelStatus.disqualifications.includes('MISSING_TOOL_CALLING_SUPPORT'));
    console.log('  ✓ Scenario 18: High-quality model lacks required tool calling passed');
  }

  // Scenario 19: Two models receive identical scores
  {
    // Ensure sorting tie-breaking order is completely deterministic
    const taskAnalysis = {
      optimization_policy: 'balanced',
      data_classification: 'public',
      production_impact: false,
      required_capabilities: {
        reasoning: 'low',
        coding: 'none',
        tool_calling: false,
        structured_output: false,
        vision: false,
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: true,
        air_gapped: false
      }
    };

    const run1 = resolveModels(taskAnalysis);
    const run2 = resolveModels(taskAnalysis);

    assert.deepEqual(run1.candidates.map(c => c.id), run2.candidates.map(c => c.id));
    console.log('  ✓ Scenario 19: Two models receive identical scores passed');
  }

  // Scenario 20: No approved model satisfies mandatory constraints
  {
    const taskAnalysis = {
      optimization_policy: 'balanced',
      data_classification: 'restricted',
      production_impact: false,
      required_capabilities: {
        reasoning: 'high',
        coding: 'none',
        tool_calling: false,
        structured_output: false,
        vision: true, // Vision required + restricted data
        minimum_context_tokens: 4096
      },
      constraints: {
        external_processing_allowed: false,
        air_gapped: true
      }
    };

    const resolution = resolveModels(taskAnalysis);
    // Since no model in registry is local + airgap compatible + supports vision, primary must be null
    assert.equal(resolution.primary, null);
    console.log('  ✓ Scenario 20: No approved model satisfies mandatory constraints passed');
  }
}
