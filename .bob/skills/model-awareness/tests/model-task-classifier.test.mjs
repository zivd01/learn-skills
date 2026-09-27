import assert from 'node:assert/strict';
import { classifyTask } from '../model-task-classifier.mjs';

export async function run() {
  console.log('Running Model Task Classifier Tests...');

  // Scenario 1: Low-risk formatting task
  {
    const result = classifyTask({
      prompt: 'Please format and lint my index.js file to fix indentation'
    });
    assert.equal(result.risk_level, 'low');
    assert.equal(result.production_impact, false);
    assert.equal(result.constraints.human_approval_required, false);
    assert.equal(result.optimization_policy, 'cost_first');
    assert.ok(result.reason_codes.includes('LOW_RISK_FORMATTING'));
    console.log('  ✓ Scenario 1: Low-risk formatting task passed');
  }

  // Scenario 2: Security review of authentication code
  {
    const result = classifyTask({
      prompt: 'Can you do a security-review on my custom login jwt authorization code?',
      skills: ['security-review']
    });
    assert.equal(result.optimization_policy, 'quality_first');
    assert.equal(result.risk_level, 'high');
    assert.equal(result.required_capabilities.reasoning, 'high');
    assert.equal(result.required_capabilities.coding, 'high');
    assert.ok(result.reason_codes.includes('HIGH_SECURITY_RISK'));
    assert.ok(result.reason_codes.includes('AUTHORIZATION_LOGIC'));
    console.log('  ✓ Scenario 2: Security review of authentication code passed');
  }

  // Scenario 5: Image-based task
  {
    const result = classifyTask({
      prompt: 'Please analyze this system-diagram png image and find vulnerabilities'
    });
    assert.equal(result.required_capabilities.vision, true);
    assert.ok(result.reason_codes.includes('VISION_REQUIRED'));
    console.log('  ✓ Scenario 5: Image-based task passed');
  }

  // Scenario 6: Long repository analysis
  {
    const result = classifyTask({
      prompt: 'Analyze my entire repo and perform a broad refactor across all files'
    });
    assert.equal(result.required_capabilities.long_context, true);
    assert.ok(result.required_capabilities.minimum_context_tokens >= 16384);
    assert.ok(result.reason_codes.includes('LONG_CONTEXT_REQUIRED'));
    console.log('  ✓ Scenario 6: Long repository analysis passed');
  }

  // Scenario 11: Low classifier confidence on production change
  {
    const result = classifyTask({
      prompt: 'Db deploy' // Very short and ambiguous but touches db/deploy
    });
    assert.equal(result.optimization_policy, 'quality_first');
    assert.equal(result.constraints.human_approval_required, true);
    assert.ok(result.reason_codes.includes('AMBIGUOUS_REQUIREMENTS'));
    assert.ok(result.reason_codes.includes('LOW_CLASSIFICATION_CONFIDENCE'));
    console.log('  ✓ Scenario 11: Low classifier confidence on production change passed');
  }

  // Scenario 17: Prompt contains credentials (Pre-flight test handled in hook, check classifier safety)
  {
    const result = classifyTask({
      prompt: 'Our password is test_password123'
    });
    // Classifier shouldn't store secrets in reason codes or anywhere
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('test_password123'), 'Secrets must not be stored in classification results');
    console.log('  ✓ Scenario 17: Prompt contains credentials passed');
  }
}
