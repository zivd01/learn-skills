# ABLE — Automatic Bob Learning and Extension

| Sometimes you don't know what you need to create a Skill — and that's exactly what ABLE solves. When a task requires capabilities Bob doesn't yet have, ABLE detects the gap, finds or builds the right Skill automatically, and gets the job done safely & securely.

---

## How It Works

When a user sends a request to Bob, the following pipeline runs automatically:

```
User sends Prompt
       |
[UserPromptSubmit Hook] code-awareness-pre-prompt.mjs
       | injects PRE-TASK AWARENESS GATE + first 300 chars of request
       |
Bob runs Skill: code-awareness
       |
  1. Classifies the task type
  2. Checks locally installed Skills
  3. Searches the web (web-browse) — at least 3 search angles
  4. If official Skill found  -> download, scan, install
  5. If not found             -> generate minimal Skill + security scan
  6. Runs the found/generated Skill
       |
[PostToolUse Hook] security-review-post-write.mjs
       | scans every written file — reports findings if any
```

---

## Project Structure

```
learn-skills/
├── .bob/
│   ├── settings.json                          <- Hook configuration
│   ├── hooks/
│   │   ├── code-awareness-pre-prompt.mjs      <- UserPromptSubmit: injects gate + prompt snippet
│   │   └── security-review-post-write.mjs     <- PostToolUse: security scan after every write
│   └── skills/
│       ├── install-log.json                   <- Installation decision log (created at runtime)
│       ├── code-awareness/
│       │   ├── SKILL.md                       <- The orchestrator: search -> install -> run
│       │   └── skill-security-verifier.mjs    <- Content scan, integrity check, install log
│       ├── web-browse/
│       │   ├── SKILL.md                       <- Docs: search / fetch / rank
│       │   └── web-browse.mjs                 <- DuckDuckGo + GitHub fallback + rank + cache
│       ├── airgap-validator/
│       │   └── SKILL.md                       <- Artifact validation before airgap deploy
│       └── security-review/
│           └── SKILL.md                       <- Code security review (6 categories)
│
└── docs/
    ├── skills-guide.md                        <- General guide to building Skills
    ├── skills-documentation.md                <- Installed Skills documentation
    └── code-awareness-guide.md                <- Deep dive on code-awareness
```

---

## Core Skills Built

### 1. `code-awareness` — The Meta Skill

**What it does:** Full Skill lifecycle orchestration — from detecting the need to installation.

**When activated:** Automatically on **every** request (via Hook), and manually with `/code-awareness`.

**Skill search priority:**
1. Locally installed Skills (`.bob/skills/`)
2. IBM Official repos (`ibm-watsonx-data-integration-skills`, `ibm-self-serve-assets`)
3. MCP Market (`mcpmarket.com/tools/skills`)
4. GitHub community (ranked by `popularityScore`)
5. Fallback: generated local minimal Skill (only if nothing found)

**Guardrails:**
- Single-Skill Cap: max 1 Skill created per session
- Anti-Recursion: will not create a Skill while editing a Skill
- SHA-256 integrity: every Skill receives a checksum in its frontmatter
- Security scan: `skill-security-verifier.mjs` must pass before installation
- Decision Log: every installation is recorded in `install-log.json`

---

### 2. `web-browse` — Search and Ranking

**What it does:** DuckDuckGo search + GitHub fallback + Brave Search fallback + repo scoring.

```bash
# Search
node .bob/skills/web-browse/web-browse.mjs search "some-skill SKILL.md github IBM"

# Fetch content
node .bob/skills/web-browse/web-browse.mjs fetch "https://raw.githubusercontent.com/..."

# Score a repo
node .bob/skills/web-browse/web-browse.mjs rank "IBM/some-repo"
```

**Features:** credential pre-flight, exponential backoff retry, 15-minute cache.

---

### 3. `security-review` — Security Audit

**What it does:** Code review across 6 categories: Secrets, Injection, Auth, Web, Dependencies, Privacy.

**When activated:** Automatically when requesting "security review", "check for vulnerabilities".

---

### 4. `airgap-validator` — Artifact Validation for Closed Environments

**What it does:** Verifies that a file contains no raw IP addresses, tunneling services,
unauthorized URLs, hardcoded credentials, or remote-exec patterns before deployment.

```bash
node .bob/skills/code-awareness/skill-security-verifier.mjs <path-to-artifact>
```

---

## 🔍 Web Search Alternatives

The `web-browse` skill uses a **3-engine fallback chain**. Below is the full menu of options —
from fully free and keyless to enterprise-grade paid APIs — so you can choose the one that fits
your volume and privacy requirements.

### Current Setup (built-in, no changes needed)

| # | Engine | Cost | Limit | Notes |
|---|--------|------|-------|-------|
| 1 | **DuckDuckGo HTML scrape** | Free, no key | Unofficial — rate-limited at high volume | Primary engine; no signup required |
| 2 | **GitHub Search API** | Free, no key | 10 req/min (unauthenticated), 30/min (token) | Auto-fallback; repo-level results only |
| 3 | **Brave Search API** | Free tier: 2,000 req/month | Paid tiers available | Full web index; free tier needs no CC |

### Free Alternatives You Can Add

| Engine | Free Tier | Key Required | Notes |
|--------|-----------|-------------|-------|
| [**SerpApi**](https://serpapi.com) | 100 searches/month | Yes | Google/Bing/DDG results; easy REST API |
| [**Serper.dev**](https://serper.dev) | 2,500 searches free (one-time) | Yes | Google results; very fast; JSON only |
| [**Tavily**](https://tavily.com) | 1,000 searches/month | Yes | Optimised for AI agents; returns summaries |
| [**OpenSERP**](https://github.com/karust/openserp) | Unlimited (self-hosted) | No | Open-source; Docker; Google + Bing + DDG |
| [**FreeSerp**](https://freeserp.ai) | Unlimited (own index) | No | Keyless REST API; 3.1B-page index |
| [**You.com API**](https://documentation.you.com) | Free tier available | Yes | Web + code + news search for AI |

### Paid / Enterprise Options

| Engine | Starting Price | Notes |
|--------|---------------|-------|
| [**Google Custom Search API**](https://developers.google.com/custom-search/v1/overview) | $5 / 1,000 queries | Official Google results; JSON API |
| [**Bing Web Search API**](https://www.microsoft.com/en-us/bing/apis/bing-web-search-api) | $3 / 1,000 queries | Microsoft; broad coverage |
| [**SerpApi Pro**](https://serpapi.com/pricing) | $50/month (5,000 searches) | All major engines; high reliability |
| [**Brave Search API — Pro**](https://brave.com/search/api) | $3 / 1,000 queries | Independent index; privacy-first |
| [**Exa (formerly Metaphor)**](https://exa.ai) | $1 / 1,000 results | Neural search; best for AI/LLM use-cases |

---

## ⚙️ How to Add or Switch a Search Engine

All search logic lives in one file:

```
.bob/skills/web-browse/web-browse.mjs
```

### Step 1 — Add your API key as an environment variable

```powershell
# PowerShell — current session only
$env:BRAVE_SEARCH_API_KEY = "BSA..."
$env:SERPER_API_KEY        = "abc123..."
$env:TAVILY_API_KEY        = "tvly-..."

# PowerShell — permanent (user scope)
[System.Environment]::SetEnvironmentVariable("SERPER_API_KEY", "abc123...", "User")
```

```bash
# macOS / Linux
export SERPER_API_KEY="abc123..."
export TAVILY_API_KEY="tvly-..."
```

### Step 2 — Add a new search function in `web-browse.mjs`

Open `.bob/skills/web-browse/web-browse.mjs` and add your engine function
**after the existing `searchBrave` function** (around line 272):

```js
// ---------------------------------------------------------------------------
// Optional: Serper.dev — Google results via REST (2,500 free searches on signup)
// Requires SERPER_API_KEY env var.  Skipped silently when key is absent.
// Sign up: https://serper.dev
// ---------------------------------------------------------------------------
async function searchSerper(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];

  const body = JSON.stringify({ q: query, num: 8 });
  // Note: Serper uses HTTPS POST — wrap in a small helper if needed
  const apiUrl = `https://google.serper.dev/search`;
  try {
    const json = await fetchWithRetry(apiUrl, {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey
    }, body);
    const data = JSON.parse(json);
    return (data.organic ?? []).slice(0, 8).map(r => ({
      url: r.link,
      snippet: r.snippet || r.title || ''
    }));
  } catch {
    return [];
  }
}
```

> **Note:** `fetchUrl` only does GET requests. For POST-based APIs (Serper, Tavily),
> add a small `postUrl(url, body, headers)` helper that uses `https.request` with
> `method: 'POST'` — the existing `fetchUrl` pattern is easy to extend (see line 88).

### Step 3 — Wire it into the fallback chain

Find the `searchWithFallback` function (around line 274) and add your engine
**as the last fallback** before the `engine: 'none'` return:

```js
async function searchWithFallback(query) {
  // ... existing DuckDuckGo + GitHub + Brave logic ...

  // NEW: add Serper as a 4th fallback
  const serperResults = await searchSerper(query);
  if (serperResults.length > 0) {
    return { engine: 'serper', results: serperResults, count: serperResults.length, cached: false };
  }

  return { engine: 'none', results: [], count: 0, cached: false };
}
```

### Step 4 — Test

```bash
node .bob/skills/web-browse/web-browse.mjs search "datastage skill SKILL.md github IBM"
```

The output will include `"engine": "serper"` (or whichever engine responded) confirming the new backend is active.

---

## How Skills Are Created — By User Request

### Scenario 1: Official Skill Found on the Web

```
User: "build a DataStage ETL flow"
       |
code-awareness searches (3 angles):
  1. "datastage skill SKILL.md github IBM"
  2. "datastage skill mcpmarket"
  3. "di-agent-flow-datastage SKILL.md github"
       |
Found: github.com/IBM/ibm-watsonx-data-integration-skills
       |
1. Download SKILL.md
2. Run skill-security-verifier.mjs -> PASS
3. Compute SHA-256, add provenance header
4. Save to .bob/skills/<skill-name>/SKILL.md
5. Run the Skill -> execute the task
```

### Scenario 2: No Skill Found -> Generate New One

```
User: "validate my artifact before airgap deployment"
       |
code-awareness searches (3 angles) -> no official Skill found
       |
Generates minimal SKILL.md (airgap-validator)
       |
1. skill-security-verifier.mjs -> PASS (0 findings)
2. Node computes SHA-256 (no CRLF issues)
3. --verify confirms hash match
4. --log adds entry to install-log.json
```

---

## Hooks — What Runs When

| Hook | Event | What It Does |
|------|-------|-------------|
| `code-awareness-pre-prompt.mjs` | `UserPromptSubmit` | Injects PRE-TASK AWARENESS GATE + first 300 chars of request |
| `security-review-post-write.mjs` | `PostToolUse` (write tools) | Scans every written file, adds findings as model context |

### `settings.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node .bob/hooks/code-awareness-pre-prompt.mjs", "timeout": 10 }]
    }],
    "PostToolUse": [{
      "matcher": "^(write_file|apply_diff|search_and_replace|insert_content)$",
      "hooks": [{ "type": "command", "command": "node .bob/hooks/security-review-post-write.mjs", "timeout": 15 }]
    }]
  }
}
```

---

## Adding a New Skill

### Automatic (recommended)

Simply describe the need to Bob:
```
"I need a skill that validates DB migrations"
```
`code-awareness` will search, find, and install — or generate if nothing exists.

### Manual

```
1. mkdir .bob/skills/my-skill
2. Create SKILL.md with frontmatter + description + steps
3. Run: node .bob/skills/code-awareness/skill-security-verifier.mjs .bob/skills/my-skill/SKILL.md
4. Open a new conversation — Skills are loaded only at conversation start
```

**Name rule:** `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case only)

---

## Provenance Header — Every Installed Skill

Every `SKILL.md` installed by the system receives a header:

```yaml
---
# Source: https://raw.githubusercontent.com/IBM/...  (or: Generated by IBM Bob)
# Checksum-SHA256: <hex>
# Verification: Verified Vendor (IBM) - Security Scan PASSED
name: ...
```

To verify integrity:
```bash
node .bob/skills/code-awareness/skill-security-verifier.mjs --verify .bob/skills/<name>/SKILL.md
```

---

## Additional Documentation

| File | Content |
|------|---------|
| [`docs/skills-guide.md`](docs/skills-guide.md) | General guide — what a Skill is, how to create, best practices |
| [`docs/code-awareness-guide.md`](docs/code-awareness-guide.md) | Deep dive on code-awareness |
| [`docs/skills-documentation.md`](docs/skills-documentation.md) | Installed Skills reference |
