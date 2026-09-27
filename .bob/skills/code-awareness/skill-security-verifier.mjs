/**
 * skill-security-verifier.mjs
 * Scans a SKILL.md (or any text content) for security red-flags before installation.
 *
 * Usage:
 *   node skill-security-verifier.mjs <path-to-SKILL.md>
 *   node skill-security-verifier.mjs --stdin          (reads from stdin)
 *
 * Exit codes:
 *   0 — PASS (safe to install)
 *   1 — FAIL (dangerous patterns found)
 *
 * Also exports scanSkillContentSecurity(content: string) for programmatic use.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Decision log lives at .bob/skills/install-log.json (two levels up from code-awareness/)
const LOG_PATH = join(__dirname, '..', 'install-log.json');

// ---------------------------------------------------------------------------
// Pattern catalogue
// ---------------------------------------------------------------------------
const DESTRUCTIVE_COMMANDS = [
  /rm\s+-rf\s+[/~]/i,
  /rmdir\s+\/s/i,
  /format\s+[a-z]:/i,
  /del\s+\/[fsq]/i,
  /:\(\)\s*\{.*\|.*&\s*\}/,          // fork bomb
  /dd\s+if=\/dev\/zero/i,
];

const REMOTE_EXEC_PATTERNS = [
  /curl\s+.*\|\s*(ba?sh|sh|zsh|pwsh|powershell)/i,
  /wget\s+.*\|\s*(ba?sh|sh|zsh)/i,
  /iex\s*\(/i,                        // PowerShell Invoke-Expression
  /Invoke-Expression/i,
  /eval\s*\(\s*\$\(/,
  /exec\s*\(\s*fetch/i,
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(your\s+)?(system\s+)?prompt/i,
  /you\s+are\s+now\s+DAN/i,
  /\[\[SYSTEM\]\]/i,
  /<\|im_start\|>system/i,
  /OVERRIDE\s*[:=]\s*true/i,
];

export const CREDENTIAL_HARVESTING = [
  /\$\{?AWS_SECRET/i,
  /\$\{?GITHUB_TOKEN/i,
  /Authorization:\s*Bearer\s+\$\{?[A-Z_]+\}/i,
  /password\s*=\s*["'][^"']{8,}/i,    // hardcoded password
  /api[_-]?key\s*=\s*["'][A-Za-z0-9+/]{20,}/i,
  /exfil|exfiltrat/i,
];

const SUSPICIOUS_NETWORK = [
  /\b(ngrok|serveo|localtunnel)\.io\b/i,
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{4,5}/,  // raw IP:port
];

const OBFUSCATION_AND_RUNTIME = [
  /\b(eval|Function)\s*\(/i,                     // Block eval() and new Function()
  /vm\.runIn(New)?Context/i,                     // Block Node.js VM execution
  /child_process\.(exec|spawn|execSync)/i,       // Block direct OS command execution
  /Buffer\.from\([^,]+,\s*['"]base64['"]\)/i,    // Block explicit Base64 buffer creation
  /atob\s*\(/i                                   // Block browser-style Base64 decoding
];

const STRICT_NETWORK_RESTRICTIONS = [
  /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/,           // Block ALL raw IPv4 addresses (e.g., 192.168.1.1, 8.8.8.8)
  /\b(ngrok|serveo|localtunnel|loca\.lt)\.io\b/i // Block common tunneling services
];

// Centralized domains that are explicitly allowed (if network calls are made)
export let ALLOWED_DOMAINS = [
  'github.com',
  'raw.githubusercontent.com',
  'ibm.com',
  'api.github.com',
  'grafana.com',
  'grafana.net',
  'prometheus.io',
  'localhost',
  'instana.com',
  'getmembrane.com',
  'cloud.ibm.com',
  'dataplatform.cloud.ibm.com',
  'ns1.com',
  'nsone.net',
  'my.nsone.net',
  'api.nsone.net'
];

try {
  const policyPath = join(__dirname, '..', 'airgap-validator', 'airgap-policy.json');
  if (existsSync(policyPath)) {
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    if (policy && Array.isArray(policy.approved_domains)) {
      ALLOWED_DOMAINS = policy.approved_domains;
    }
  }
} catch (e) {
  // Safe fallback to hardcoded domains
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
export function scanSkillContentSecurity(content) {
  const findings = [];

  function check(patterns, category) {
    for (const pat of patterns) {
      const m = content.match(pat);
      if (m) findings.push({ category, pattern: pat.toString(), match: m[0].slice(0, 80) });
    }
  }

  // 1. Check if unauthorized domains are accessed (basic check)
  const urlRegex = /https?:\/\/([a-zA-Z0-9.-]+)/g;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(content)) !== null) {
    const domain = urlMatch[1];
    const isAllowed = ALLOWED_DOMAINS.some(allowed => domain.endsWith(allowed));
    if (!isAllowed) {
      findings.push({ category: 'UNAUTHORIZED_DOMAIN', pattern: domain, match: urlMatch[0] });
    }
  }

  // 2. Decode and scan potential Base64 payloads
  function checkBase64Payloads() {
    // Matches continuous Base64 strings longer than 20 chars
    const base64Regex = /(?:[A-Za-z0-9+/]{4}){5,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
    let match;
    while ((match = base64Regex.exec(content)) !== null) {
      try {
        const decoded = Buffer.from(match[0], 'base64').toString('utf8');
        // Test decoded string against destructive commands
        for (const pat of DESTRUCTIVE_COMMANDS) {
          if (pat.test(decoded)) {
            findings.push({ category: 'HIDDEN_DESTRUCTIVE_COMMAND', pattern: pat.toString(), match: decoded.slice(0, 80) });
          }
        }
      } catch (e) { /* Ignore invalid base64 */ }
    }
  }

  // Execute standard checks
  check(DESTRUCTIVE_COMMANDS,      'DESTRUCTIVE_COMMAND');
  check(REMOTE_EXEC_PATTERNS,      'REMOTE_EXEC');
  check(PROMPT_INJECTION_PATTERNS, 'PROMPT_INJECTION');
  check(CREDENTIAL_HARVESTING,     'CREDENTIAL_HARVESTING');
  check(STRICT_NETWORK_RESTRICTIONS, 'SUSPICIOUS_NETWORK_IP');
  check(OBFUSCATION_AND_RUNTIME,   'RUNTIME_OBFUSCATION');
  
  // Execute Base64 deep scan
  checkBase64Payloads();

  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const passed = findings.length === 0;

  return { passed, sha256, findings };
}

// ---------------------------------------------------------------------------
// Integrity verification — parse declared Checksum-SHA256 and validate against
// the actual hash of the file content that the header annotates.
//
// The provenance header added by the installer looks like:
//
//   ---
//   # Source: https://...
//   # Checksum-SHA256: <hex>
//   # Verification: ...
//   name: ...
//
// The declared hash was computed over the upstream raw content BEFORE the
// provenance header was prepended.  We therefore strip only the comment lines
// (lines starting with #) inside the opening --- block to reconstruct the
// original content and hash it for comparison.
// ---------------------------------------------------------------------------

export class IntegrityError extends Error {
  /**
   * @param {string} filePath  - path of the offending file (already deleted)
   * @param {string} declared  - hash stored in the Checksum-SHA256 header
   * @param {string} actual    - hash computed from the file content
   */
  constructor(filePath, declared, actual) {
    super(
      `Integrity Check Failed: Hash Mismatch\n` +
      `  File    : ${filePath}\n` +
      `  Declared: ${declared}\n` +
      `  Actual  : ${actual}`
    );
    this.name = 'IntegrityError';
    this.filePath = filePath;
    this.declared = declared;
    this.actual = actual;
  }
}

/**
 * Strips the installer-prepended comment lines from inside the opening YAML
 * fence and returns the reconstructed original content.
 *
 * Input example:
 *   ---\n# Source: …\n# Checksum-SHA256: …\n# Verification: …\nname: foo\n…
 *
 * Output:
 *   ---\nname: foo\n…
 *
 * Lines that start with `# ` and appear between the opening `---` and the
 * first non-comment, non-blank line are removed.  Everything else is kept
 * byte-for-byte.
 */
function stripProvenanceComments(content) {
  const lines = content.split('\n');
  if (lines[0].trimEnd() !== '---') return content; // not our format — return as-is

  const out = ['---'];
  let inHeader = true;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (inHeader && /^#\s/.test(line)) {
      // provenance comment line — omit it
      continue;
    }
    inHeader = false; // first non-comment line ends the header zone
    out.push(line);
  }

  return out.join('\n');
}

/**
 * Extracts the declared Checksum-SHA256 value from the provenance header.
 * Returns null if no such header is present (file was not installed by this
 * workflow and therefore has nothing to verify against).
 *
 * @param {string} content  raw file content
 * @returns {string|null}
 */
function extractDeclaredChecksum(content) {
  const match = content.match(/^#\s*Checksum-SHA256:\s*([0-9a-f]{64})\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates the integrity of a downloaded SKILL.md file.
 *
 * Steps:
 *   1. Read the file at `filePath`.
 *   2. Parse the Checksum-SHA256 from the provenance header.
 *   3. Strip provenance comment lines to reconstruct the original content.
 *   4. Compute SHA-256 of the reconstructed content.
 *   5. Compare declared vs actual — on mismatch, delete the file and throw
 *      an IntegrityError.
 *
 * @param {string} filePath  - absolute or relative path to the SKILL.md file
 * @throws {IntegrityError}  - when the hash does not match (file is deleted first)
 * @throws {Error}           - when no Checksum-SHA256 header is found
 * @returns {{ declared: string, actual: string, match: true }}  on success
 */
export function verifySkillIntegrity(filePath) {
  const content = readFileSync(filePath, 'utf8');

  const declared = extractDeclaredChecksum(content);
  if (!declared) {
    throw new Error(
      `Integrity Check Skipped: no Checksum-SHA256 header found in "${filePath}".\n` +
      `Only skills installed via the code-awareness workflow carry this header.`
    );
  }

  const originalContent = stripProvenanceComments(content);
  const actual = createHash('sha256').update(originalContent, 'utf8').digest('hex');

  if (actual !== declared) {
    // Delete the corrupt/tampered file before throwing
    try { unlinkSync(filePath); } catch { /* best-effort */ }
    throw new IntegrityError(filePath, declared, actual);
  }

  return { declared, actual, match: true };
}

// ---------------------------------------------------------------------------
// Decision Log — append one entry per install attempt
// ---------------------------------------------------------------------------
export function appendInstallLog(entry) {
  let log = [];
  try {
    if (existsSync(LOG_PATH)) log = JSON.parse(readFileSync(LOG_PATH, 'utf8'));
  } catch { /* start fresh */ }
  log.push({ timestamp: new Date().toISOString(), ...entry });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Single-Skill Cap check — returns how many skills were installed this session
// ---------------------------------------------------------------------------
export function countSessionInstalls(sessionId) {
  try {
    if (!existsSync(LOG_PATH)) return 0;
    const log = JSON.parse(readFileSync(LOG_PATH, 'utf8'));
    return log.filter(e => e.sessionId === sessionId && e.action === 'installed').length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  let content = '';
  const arg = process.argv[2];

  // --log mode: append a decision log entry
  if (arg === '--log') {
    try {
      const entry = JSON.parse(process.argv[3] || '{}');
      appendInstallLog(entry);
      console.log(JSON.stringify({ logged: true, path: LOG_PATH }));
    } catch (e) {
      console.error('--log requires a JSON string as second argument:', e.message);
      process.exit(1);
    }
    return;
  }

  // --cap mode: check single-skill cap for a session
  if (arg === '--cap') {
    const sessionId = process.argv[3] || 'default';
    const count = countSessionInstalls(sessionId);
    const allowed = count < 1;
    console.log(JSON.stringify({ sessionId, installedThisSession: count, allowed }));
    process.exit(allowed ? 0 : 1);
  }

  // --verify mode: integrity check a SKILL.md file
  if (arg === '--verify') {
    const targetPath = process.argv[3];
    if (!targetPath) {
      console.error('--verify requires a file path argument');
      process.exit(1);
    }
    try {
      const result = verifySkillIntegrity(targetPath);
      console.log(JSON.stringify({ verified: true, ...result }));
      process.exit(0);
    } catch (err) {
      const isIntegrityErr = err instanceof IntegrityError;
      console.error(JSON.stringify({
        verified: false,
        error: err.name,
        message: err.message,
        ...(isIntegrityErr && { declared: err.declared, actual: err.actual, fileDeleted: true })
      }));
      process.exit(isIntegrityErr ? 3 : 1);
    }
  }

  if (arg === '--stdin') {
    for await (const chunk of process.stdin) content += chunk;
  } else if (arg) {
    content = readFileSync(arg, 'utf8');
  } else {
    console.error('Usage: node skill-security-verifier.mjs <path> | --stdin | --log <json> | --cap <sessionId> | --verify <path>');
    process.exit(1);
  }

  const { passed, sha256, findings } = scanSkillContentSecurity(content);
  console.log(JSON.stringify({ passed, sha256, findings }, null, 2));
  process.exit(passed ? 0 : 1);
}

// Only run as CLI when this file is the entry point, not when imported as a module
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main();
}
