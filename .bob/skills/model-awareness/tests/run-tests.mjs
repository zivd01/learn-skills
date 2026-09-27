/**
 * run-tests.mjs
 * Master test runner for the model-awareness pre-execution capability optimizer.
 */

import { run as runClassifier } from './model-task-classifier.test.mjs';
import { run as runPolicyResolver } from './model-policy-resolver.test.mjs';
import { run as runRoutingEnforcement } from './routing-enforcement.test.mjs';
import { run as runSecurityPolicy } from './security-policy.test.mjs';
import { run as runExecutionManifest } from './execution-manifest.test.mjs';

async function main() {
  console.log('=== STARTING MODEL-AWARENESS OPTIMIZER TEST SUITE ===');
  let failures = 0;

  try {
    await runClassifier();
  } catch (err) {
    console.error('❌ Model Task Classifier Tests FAILED:', err);
    failures++;
  }

  try {
    await runPolicyResolver();
  } catch (err) {
    console.error('❌ Model Policy Resolver Tests FAILED:', err);
    failures++;
  }

  try {
    await runRoutingEnforcement();
  } catch (err) {
    console.error('❌ Routing Enforcement Tests FAILED:', err);
    failures++;
  }

  try {
    await runSecurityPolicy();
  } catch (err) {
    console.error('❌ Security Policy Tests FAILED:', err);
    failures++;
  }

  try {
    await runExecutionManifest();
  } catch (err) {
    console.error('❌ Execution Manifest Tests FAILED:', err);
    failures++;
  }

  console.log('=== TEST SUITE COMPLETED ===');
  if (failures > 0) {
    console.error(`❌ ${failures} test suite(s) failed.`);
    process.exit(1);
  } else {
    console.log('🟢 All tests PASSED successfully!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Unexpected crash in test runner:', err);
  process.exit(1);
});
