---
name: code-awareness
description: >
  Analyzes technical and coding tasks (pre-execution or post-execution)
  to detect missing capabilities, identify relevant installed skills,
  search and fetch the best official/open-source vendor skills from external registries/GitHub,
  and only fallback to generating a custom skill when no upstream skill exists.
metadata:
  argument-hint: "[optional task description or execution context]"
  default-mode: auto-create
  generated-skills-per-run: 1
  recursion-depth: 0
---

# Code Awareness & Automated Skill Lifecycle

## Purpose

1. Evaluate task context (pre-execution or post-task review).
2. Map required capabilities against available installed skills.
3. Dynamically assess relevant risk surfaces based on the task type.
4. **Search & Fetch First**: Discover and download the best official vendor / community `SKILL.md` files (comparing Paid vs. Best Free).
5. **Fallback Build**: Only generate a custom skill if no existing official/community skill is found.
6. Invoke newly installed skills to complete or verify the task.

## Modes

- `auto-create`: (Default) Generate, validate, and install missing read/eval skills automatically. Require explicit confirmation for high-privilege execution skills.
- `recommend`: Identify gaps and suggest existing or draft skills without installing.
- `execute`: Run verified skills directly.

## Guardrails & Security Verification Gate

1. **Vendor Trust Allowlist**: Only fetch external skills from verified vendor organizations (`IBM/*`, `ibm-self-serve-assets/*`, `modelcontextprotocol/*`, `anthropics/*`). Reject unverified sources.
2. **Cryptographic Integrity & SHA-256**: Calculate and store the SHA-256 checksum for every installed skill. Reject if hash mismatch occurs.
3. **Static Security Content Scan**: Pre-scan the `SKILL.md` and helper scripts using `skill-security-verifier.mjs` before saving to disk. Instantly reject files with destructive commands (`rm -rf`, `iex`, `curl_pipe_sh`), prompt injection patterns, or credential harvesting logic.
4. **Single-Skill Cap**: Maximum 1 downloaded or generated skill per task execution. Before installing any skill, run:
   ```bash
   node .bob/skills/code-awareness/skill-security-verifier.mjs --cap <sessionId>
   ```
   If `allowed: false` — stop and ask the user to confirm installing additional skills.
5. **Anti-Recursion**: If the current task is creating or modifying a skill, do not generate or download a new skill.
6. **Verification Gate**: Only install skills that achieve `PASS` on syntax, security scan, and trigger quality.
7. **Decision Log**: After every install (success or failure) append an entry to `.bob/skills/install-log.json` via:
   ```bash
   node .bob/skills/code-awareness/skill-security-verifier.mjs --log '{"sessionId":"<id>","action":"installed","skill":"<name>","source":"<url>","sha256":"<hash>","scanPassed":true}'
   ```

## Execution Steps

### 1. Capability & Task Classification
Identify mission context:
- Type: `feature` | `bugfix` | `refactor` | `infra` | `db` | `security` | `pipeline`
- Context: Files touched, tools invoked, operations requested.
- Missing Capabilities: Define required competencies (e.g., AST verification, schema rollback verification, contract testing).

### 2. Targeted Risk Scan
Evaluate only risk categories relevant to the classified mission type:
- If touching data/models: Schema migration safety, rollback path, PII leaks.
- If touching endpoints/auth: Input sanitization, authorization bypass, credential handling.
- If touching dependencies/infra: Vulnerability vectors, pipeline failure modes.

### 3. Skill & Capability Gap Analysis
1. **Local Check First**: Check workspace (`.bob/skills/`) and global (`~/.bob/skills/`) installed skills.
2. **Search & Discovery (STRICT ORDER OF PRECEDENCE)**:
   When no local skill satisfies the requirement, search external sources using `web-browse`.
   **Search engine fallback chain** (automatic, no action required):
   `DuckDuckGo` → `GitHub API` → `Brave Search API` (if `BRAVE_SEARCH_API_KEY` is set) → `none`
   Setting `BRAVE_SEARCH_API_KEY` in the environment significantly improves fallback quality
   when DuckDuckGo is rate-limited. Free tier at brave.com/search/api (2,000 req/month, no CC).
   **IMPORTANT — Hebrew / Non-Latin Product Name Recognition:**
   When a user mentions IBM product names in Hebrew or another non-Latin script, identify
   the original-language term as the primary product and search using its **English name**:
   | Hebrew | English product name |
   |--------|---------------------|
   | אינסטנה | Instana |
   | דאטאסטייג׳ / דאטהסטייג׳ | DataStage |
   | ווטסונקס | watsonx |
   | קלאוד פאק | Cloud Pak |
   | מיינפריים | IBM Z / Mainframe |
   Always resolve the English product name first, then run the 3-angle search below with that name.

   **IMPORTANT — Search Query Strategy:**
   - Do NOT only search with the product name (e.g. "DataStage SKILL.md") — official skills often use internal codenames.
   - Run **at least 3 different query angles** before concluding nothing exists:
     1. `<product> agent skill SKILL.md github IBM` — finds internal IBM skill repos
     2. `<product> skill mcpmarket` — finds skills listed on MCP Market (mcpmarket.com)
     3. `<internal-codename> SKILL.md github` — e.g. for DataStage: `di-agent-flow-datastage SKILL.md github`
   - After each search, **fetch the top result page** to verify it actually contains a SKILL.md file.
   - **Priority 1: Official Vendor Skills (היצרן הרשמי)**
     Search official repositories (e.g. `IBM/*`, official project orgs, official SDK repos) for existing `skills/<name>/SKILL.md` files.
     For IBM products specifically, also search:
     - `github.com/IBM/ibm-watsonx-data-integration-skills` — DataStage / data integration skills
     - `github.com/ibm-self-serve-assets/building-blocks` — IBM Bob building blocks
     - `mcpmarket.com/tools/skills` — MCP Market skill registry (IBM publishes here)
   - **Priority 2: Top-Rated Open-Source / Community Skills**
     Search MCP registries, GitHub repositories, and skill hubs for proven community skills (`SKILL.md` or MCP wrappers).
     **Rank candidates before choosing** — run for each GitHub repo found:
     ```bash
     node .bob/skills/web-browse/web-browse.mjs rank <owner/repo>
     ```
     Returns `{ popularityScore, stars, daysSincePush, openIssues, type }`.
     Pick the highest `popularityScore`. IBM vendor repos always preferred over community regardless of score.
   - **Identify & Present Options**:
     - 💎 **Premium / Paid Option** (e.g. Managed SaaS, Enterprise Connector, with price/features).
     - 🟢 **Best Free Option** (Official Open-Source or Top Community `SKILL.md` file) — include ⭐ stars and last-push date.
3. **Download & Direct Installation (Skills Only - No guides/links)**:
   - Download the **actual raw `SKILL.md` file** (and any required helper scripts) directly into `.bob/skills/<skill-name>/SKILL.md`.
   - For GitHub files: always use `raw.githubusercontent.com` URL, not the `github.com/blob/` URL.
   - Never output tutorials, blog posts, documentation links, or guides instead of real skill files.

### 4. Installation vs. Fallback Generation & Security Verification
- **Provenance & Integrity Header Rule (Strict)**:
  Every installed or generated `SKILL.md` MUST include valid English YAML comments right after the opening `---` stating its origin and SHA-256 integrity hash:
  - For downloaded upstream skills:
    ```markdown
    ---
    # Source: <Verified Vendor Repository / Registry URL>
    # Checksum-SHA256: <Calculated SHA-256 Hash>
    # Verification: Verified Vendor (IBM) - Security Scan PASSED
    ```
  - For generated fallback skills:
    ```markdown
    ---
    # Source: Generated by IBM Bob (Autonomous Skill Lifecycle)
    # Checksum-SHA256: <Calculated SHA-256 Hash>
    # Verification: Local Bob Generation - Security Scan PASSED
    ```

- **Step 4A — External Skill Found (Primary)**:
  1. Validate URL against `TRUSTED_VENDOR_ORGS` allowlist (`IBM/*`, etc.).
  2. Run `scanSkillContentSecurity` via `skill-security-verifier.mjs` to confirm zero destructive patterns, prompt injections, or credential leaks.
  3. Prepend origin + SHA-256 header and save directly to disk. **Do NOT write a custom skill.**

- **Step 4B — No External Skill Found (Strict Fallback Only)**:
  ONLY when exhaustive search confirms no official skill exists, generate a minimal custom skill adhering to:
  - Single specific responsibility.
  - Strict frontmatter with provenance + SHA-256 hash comments.
  - Security Scan `PASS` before installation.

### 5. Final Report (User-Facing Output)
You MUST provide a concise, user-centric output using EXACTLY the "Traffic Light" format below. Do not include raw JSON, stack traces, YAML frontmatter, or complex technical jargon in your final message to the user.

- 🟢 **Best Free Option:** [Insert Exact Skill/Tool Name] — [Insert Community Rating, e.g., ⭐ 1.2k / 1M Downloads] — [Write exactly ONE simple sentence explaining why this solves the user's problem].
- 💎 **Premium / Enterprise Option:** [Insert Exact Skill/Tool Name] — 💰 [Insert Estimated Cost/Tier] — [Write exactly ONE simple sentence highlighting the core business value, e.g., "Provides 24/7 SLA, managed security, and out-of-the-box integrations"].
- ⚙️ **Security & Execution Status:** The code has been successfully verified. The required skill passed the security scan (0 vulnerabilities found) and is securely installed and ready to use.