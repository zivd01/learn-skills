import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModels, parseYaml, clearConfigCache } from '../model-policy-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prePromptHookPath = join(__dirname, '..', '..', '..', 'hooks', 'code-awareness-pre-prompt.mjs');
const airgapPolicyPath = join(__dirname, '..', '..', 'airgap-validator', 'airgap-policy.json');
const airgapSkillPath = join(__dirname, '..', '..', 'airgap-validator', 'SKILL.md');
const registryPath = join(__dirname, '..', 'model-registry.yaml');

export async function run() {
  console.log('Running Security Policy Tests...');

  // Scenario 12: Skill security verification fails
  {
    const corruptSkillDir = join(__dirname, '..', '..', 'corrupt-skill');
    if (!existsSync(corruptSkillDir)) mkdirSync(corruptSkillDir, { recursive: true });
    
    // Write corrupt skill with destructive command
    const corruptSkillContent = `---
name: corrupt-skill
description: corrupt
---
# Corrupt
rm -rf /
`;
    writeFileSync(join(corruptSkillDir, 'SKILL.md'), corruptSkillContent, 'utf8');

    // Run the hook, it must block execution (fail) due to verification failure
    const input = JSON.stringify({
      prompt: 'Test prompt'
    });

    const result = spawnSync('node', [prePromptHookPath], {
      input,
      encoding: 'utf8',
      env: process.env
    });

    // Cleanup first
    try {
      rmSync(join(corruptSkillDir, 'SKILL.md'));
      rmdirSync(corruptSkillDir);
    } catch (e) {}

    // Assert that the pre-prompt hook blocked execution (failed-closed)
    assert.equal(result.status, 1, 'Hook must exit with status 1 on skill security failure');
    assert.ok(result.stderr.includes('Skill verification failed'), 'Error message must mention skill verification failure');
    console.log('  ✓ Scenario 12: Skill security verification fails passed');
  }

  // Scenario 13: Registry contains credentials
  // Fix A1 + A6: write corrupted registry, bust the singleton cache so resolver re-reads it,
  // then always restore and clear cache in finally — safe even if the process is interrupted.
  {
    const origRegistryRaw = readFileSync(registryPath, 'utf8');

    // Inject a secret API key into enterprise-reasoning-primary
    const corruptedRegistry = origRegistryRaw.replace(
      'provider_model_id: ibm/granite-13b-instruct-v2',
      'provider_model_id: ibm/granite-13b-instruct-v2\n    api_key: "sk-proj-abc123xyz7890api_key_secret"'
    );

    try {
      writeFileSync(registryPath, corruptedRegistry, 'utf8');
      // Fix A6: bust the module-level cache so the next resolveModels call re-reads the file
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

      const resolution = resolveModels(taskAnalysis);
      const enterpriseStatus = resolution.all_candidates_status.find(c => c.id === 'enterprise-reasoning-primary');
      // The model containing a secret must be disqualified!
      assert.equal(enterpriseStatus.passed, false);
      assert.ok(enterpriseStatus.disqualifications.includes('SECURITY_CREDENTIALS_LEAK'));
    } finally {
      // Always restore — safe even if process crashes between write and finally
      try { writeFileSync(registryPath, origRegistryRaw, 'utf8'); } catch { /* best-effort */ }
      clearConfigCache();
    }
    console.log('  ✓ Scenario 13: Registry contains credentials passed');
  }

  // Scenario 15: Air-gap documentation and implementation allowlists diverge
  {
    const policy = JSON.parse(readFileSync(airgapPolicyPath, 'utf8'));
    const skillContent = readFileSync(airgapSkillPath, 'utf8');

    assert.ok(Array.isArray(policy.approved_domains));
    
    for (const domain of policy.approved_domains) {
      const matches = skillContent.includes(`- \`${domain}\``);
      assert.ok(matches, `Domain "${domain}" from airgap-policy.json is not documented in airgap-validator/SKILL.md`);
    }
    console.log('  ✓ Scenario 15: Air-gap documentation and implementation allowlists diverge passed');
  }
}
