# SETUP — Installing the Skill Lifecycle System on Your Bob

This guide explains how to copy the automated Skill lifecycle system from this repository
into **any existing Bob workspace** — from scratch, in under 5 minutes.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| [IBM Bob](https://www.ibm.com/products/bob) | any recent | open Bob and confirm it loads |
| [Node.js](https://nodejs.org) | v18 or later | `node --version` |
| An existing Bob workspace folder | — | the folder Bob already uses |

> **Tip:** Bob's workspace folder is the folder you opened in Bob (shown in the title bar).
> All paths in this guide are **relative to that folder**.

---

## What Gets Installed

```
your-workspace/
└── .bob/
    ├── settings.json                          ← Hook wiring (created / merged)
    ├── hooks/
    │   ├── code-awareness-pre-prompt.mjs      ← Fires on every prompt
    │   └── security-review-post-write.mjs     ← Fires after every file write
    └── skills/
        ├── code-awareness/
        │   ├── SKILL.md                       ← Core orchestrator skill
        │   └── skill-security-verifier.mjs    ← Security scanner + install log
        ├── web-browse/
        │   ├── SKILL.md                       ← Web search skill docs
        │   └── web-browse.mjs                 ← DuckDuckGo / GitHub / Brave search
        ├── airgap-validator/
        │   └── SKILL.md                       ← Airgap artifact validator
        ├── security-review/
        │   └── SKILL.md                       ← Code security review skill
        └── wasm-performance/
            └── SKILL.md                       ← WebAssembly profiling & optimization
```

---

## Option A — Clone Directly into Your Workspace (Recommended)

If your workspace folder does **not** already have a `.bob/` directory (fresh workspace):

```bash
# 1. Open a terminal in your Bob workspace folder
cd /path/to/your-bob-workspace

# 2. Clone only the .bob folder from this repo (sparse checkout)
git clone --no-checkout https://github.com/zivd01/learn-skills.git _tmp_ls
cd _tmp_ls
git sparse-checkout init --cone
git sparse-checkout set .bob
git checkout main
cd ..

# 3. Copy .bob into your workspace
cp -r _tmp_ls/.bob ./.bob        # macOS / Linux
# xcopy /E /I _tmp_ls\.bob .\.bob  # Windows CMD
# Copy-Item -Recurse _tmp_ls\.bob .\.bob  # Windows PowerShell

# 4. Remove the temp clone
rm -rf _tmp_ls    # macOS / Linux
# Remove-Item -Recurse -Force _tmp_ls  # PowerShell
```

> **Windows PowerShell one-liner:**
> ```powershell
> git clone --no-checkout https://github.com/zivd01/learn-skills.git _tmp_ls
> cd _tmp_ls
> git sparse-checkout init --cone
> git sparse-checkout set .bob
> git checkout main
> cd ..
> Copy-Item -Recurse _tmp_ls\.bob .\.bob
> Remove-Item -Recurse -Force _tmp_ls
> ```

---

## Option B — Manual Copy (if you already have a `.bob/` folder)

If your workspace already has a `.bob/` directory with other settings,
copy each sub-folder individually to avoid overwriting your existing config.

### 1. Copy the skills

```powershell
# PowerShell
$src = "C:\path\to\learn-skills\.bob\skills"
$dst = "C:\path\to\your-workspace\.bob\skills"

Copy-Item -Recurse "$src\code-awareness"   "$dst\code-awareness"
Copy-Item -Recurse "$src\web-browse"       "$dst\web-browse"
Copy-Item -Recurse "$src\airgap-validator" "$dst\airgap-validator"
Copy-Item -Recurse "$src\security-review"  "$dst\security-review"
Copy-Item -Recurse "$src\wasm-performance" "$dst\wasm-performance"
```

```bash
# macOS / Linux
SRC=/path/to/learn-skills/.bob
DST=/path/to/your-workspace/.bob

cp -r "$SRC/skills/code-awareness"    "$DST/skills/"
cp -r "$SRC/skills/web-browse"        "$DST/skills/"
cp -r "$SRC/skills/airgap-validator"  "$DST/skills/"
cp -r "$SRC/skills/security-review"   "$DST/skills/"
cp -r "$SRC/skills/wasm-performance"  "$DST/skills/"
```

### 2. Copy the hooks

```powershell
# PowerShell
Copy-Item "$src\..\hooks\code-awareness-pre-prompt.mjs"   "$dst\..\hooks\"
Copy-Item "$src\..\hooks\security-review-post-write.mjs"  "$dst\..\hooks\"
```

```bash
# macOS / Linux
cp "$SRC/hooks/code-awareness-pre-prompt.mjs"   "$DST/hooks/"
cp "$SRC/hooks/security-review-post-write.mjs"  "$DST/hooks/"
```

### 3. Merge the hook configuration into `settings.json`

Open `.bob/settings.json` in your workspace. If it **does not exist**, create it with:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .bob/hooks/code-awareness-pre-prompt.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(write_file|apply_diff|search_and_replace|insert_content)$",
        "hooks": [
          {
            "type": "command",
            "command": "node .bob/hooks/security-review-post-write.mjs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

If `settings.json` **already exists**, add the two hook blocks shown above into the
existing `"UserPromptSubmit"` and `"PostToolUse"` arrays (do not replace the whole file).

---

## Verify the Installation

Run the security verifier to confirm Node.js can load the skill:

```bash
node .bob/skills/code-awareness/skill-security-verifier.mjs .bob/skills/code-awareness/SKILL.md
```

Expected output (last line):

```json
{ "passed": true, "findings": [] }
```

Run a test search to confirm `web-browse` is working:

```bash
node .bob/skills/web-browse/web-browse.mjs search "IBM Bob skill SKILL.md github"
```

Expected output contains `"engine": "duckduckgo"` (or `"github"`) and at least one result.

---

## Activate in Bob

1. **Restart Bob** (or open a new conversation) — Skills and Hooks are loaded once at session start.
2. Send any message. Bob will automatically inject the **PRE-TASK AWARENESS GATE** before processing.
3. You should see `[PRE-TASK AWARENESS GATE]` appear at the top of Bob's system context for every prompt.

### Confirm the hook is running

After sending a message, check Bob's context panel (or the hook log).
You should see the gate instruction:

```
[PRE-TASK AWARENESS GATE]
Before generating code or executing changes for the user's request:
1. Analyze the mission using the 'code-awareness' skill ...
```

---

## Optional: Enable Brave Search (Better Web Results)

The system works without any API keys. To unlock the Brave Search fallback
(free tier: 2,000 searches/month, no credit card):

1. Sign up at **https://brave.com/search/api**
2. Copy your API key
3. Set the environment variable **before** launching Bob:

```powershell
# PowerShell — permanent (user scope, survives restarts)
[System.Environment]::SetEnvironmentVariable("BRAVE_SEARCH_API_KEY", "BSA...", "User")
```

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export BRAVE_SEARCH_API_KEY="BSA..."
```

---

## Troubleshooting

### Hook not running

- Check that `settings.json` is valid JSON (no trailing commas).
- Confirm the file is at `.bob/settings.json` (not `settings.json` at the root).
- Restart Bob after editing `settings.json`.

### `node` not found

- Install Node.js v18+ from https://nodejs.org
- On Windows, restart your terminal after installation so `PATH` updates.

### `Cannot find module` error from a hook

- Make sure you copied **both** the hooks folder **and** the skills folder.
- The hooks import the verifier via a relative path: `.bob/skills/code-awareness/skill-security-verifier.mjs`
  — this file must exist.

### Skills not showing in Bob

- Skills are only loaded when Bob **starts a new conversation**.
- Close the current conversation and open a fresh one.

### Security scan reports false positives in documentation files

- This is expected. The scanner flags external URLs in `.md` files as `UNAUTHORIZED_DOMAIN`.
- These are documentation links and pose no real risk. The hook reports them as informational context — it does **not** block any operation.

---

## What Happens After Installation

Every time you send a prompt to Bob, the system automatically:

```
Your prompt
     │
[UserPromptSubmit Hook]  ← code-awareness-pre-prompt.mjs
     │  injects PRE-TASK AWARENESS GATE + first 300 chars of your prompt
     ▼
Bob processes your request using 'code-awareness' skill
     │
     ├─ Classifies task type
     ├─ Checks local .bob/skills/ for matching skill
     ├─ Searches web (DuckDuckGo → GitHub → Brave) for official skill
     ├─ Downloads + security-scans the skill (SHA-256 verified)
     └─ Runs the skill  OR  generates a minimal new one
     │
[PostToolUse Hook]  ← security-review-post-write.mjs
     │  scans every file Bob writes — flags secrets, injection, bad patterns
     ▼
Task complete
```

---

## File Reference

| File | Purpose |
|------|---------|
| `.bob/settings.json` | Wires the two hooks into Bob's lifecycle events |
| `.bob/hooks/code-awareness-pre-prompt.mjs` | Prepends the awareness gate to every prompt |
| `.bob/hooks/security-review-post-write.mjs` | Scans every written file for security issues |
| `.bob/skills/code-awareness/SKILL.md` | Core skill: search → install → run lifecycle |
| `.bob/skills/code-awareness/skill-security-verifier.mjs` | SHA-256 check, content scan, install log |
| `.bob/skills/web-browse/SKILL.md` | Documents the web-browse search skill |
| `.bob/skills/web-browse/web-browse.mjs` | DuckDuckGo + GitHub + Brave search engine |
| `.bob/skills/airgap-validator/SKILL.md` | Validates artifacts for air-gapped environments |
| `.bob/skills/security-review/SKILL.md` | Code security review across 6 risk categories |
| `.bob/skills/wasm-performance/SKILL.md` | WebAssembly profiling, SIMD, memory optimization |

---

## Further Reading

| Document | Content |
|----------|---------|
| [`README.md`](README.md) | Full project overview, architecture, and search engine alternatives |
| [`docs/skills-guide.md`](docs/skills-guide.md) | How to author a Skill from scratch |
| [`docs/code-awareness-guide.md`](docs/code-awareness-guide.md) | Deep dive on the code-awareness orchestrator |
| [`docs/skills-documentation.md`](docs/skills-documentation.md) | Reference for all installed Skills |
