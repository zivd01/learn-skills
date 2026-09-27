import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prePromptHookPath = join(__dirname, '..', '..', '..', 'hooks', 'code-awareness-pre-prompt.mjs');
const logPath = join(__dirname, '..', 'model-routing-log.json');

export async function run() {
  console.log('Running Execution Manifest Tests...');

  // Check that executing the hook generates a proper audit log entry with correct schema fields
  {
    const input = JSON.stringify({
      prompt: 'Test writing a unit test for my feature'
    });

    const result = spawnSync('node', [prePromptHookPath], {
      input,
      encoding: 'utf8',
      env: process.env
    });

    assert.equal(result.status, 0);

    // Read the last log record
    assert.ok(existsSync(logPath), 'model-routing-log.json must be created');
    const logs = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok(logs.length > 0);
    const lastLog = logs[logs.length - 1];

    // Assert mandatory fields are present and correct
    assert.ok(lastLog.timestamp);
    assert.ok(lastLog.decision_id);
    assert.ok(lastLog.prompt_hash);
    assert.ok(lastLog.task_type);
    assert.ok(lastLog.risk_level);
    assert.ok(lastLog.data_classification);
    assert.ok(Array.isArray(lastLog.selected_skills));
    assert.ok(lastLog.optimization_policy);
    assert.ok(lastLog.recommended_model_profile);
    assert.ok(lastLog.fallback_model_profile);
    assert.ok(lastLog.routing_enforcement);
    assert.ok(Array.isArray(lastLog.reason_codes));
    assert.equal(typeof lastLog.human_approval_required, 'boolean');

    // Confirm prompt content is NOT written to logs
    assert.ok(!JSON.stringify(lastLog).includes('Test writing a unit test'), 'Logs must not contain raw prompt text');
    console.log('  ✓ Scenario 13 & 14 & 16: Execution manifest logging verified');
  }
}
