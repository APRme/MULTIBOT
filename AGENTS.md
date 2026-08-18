# AGENTS.md

## Scope

These instructions apply only to the `MULTIBOT/` directory tree.

## Git 提交约定

- 每次完成一个改动批次后，立即用 `git` 提交（除非用户明确要求暂不提交）。
- 提交前先确认改动范围内的测试通过、`git status` 干净。
- 提交信息应简短、准确地描述该批次改动。尽量使用中文(专业术语除外)

## Project Focus

`MULTIBOT` is the main active backend project in this workspace:

- single-process, multi-bot runtime
- built around `mineflayer`
- controlled by whisper, HTTP API, and SSE
- provides bot control, recording, and instance management

Unless the user explicitly asks otherwise, new feature work should land in `MULTIBOT/`.

## Default Development Direction

- Prefer **behavior compatibility and stability** over broad refactors.
- Prioritize **command alignment and behavior compatibility** over broad refactors.
- Make **surgical changes**; do not redesign subsystems unless the task requires it.
- Preserve existing HTTP API / SSE behavior unless protocol changes are explicitly requested.
- Prefer explicit success/failure replies over silent no-op behavior.

## Hard Constraints

- Inside `MULTIBOT`, **never directly require files from outside the project tree**.
- If old logic must be reused, keep it inside `MULTIBOT/src/legacy/`.
- Keep current config merge priority unless explicitly asked to change it:
  - instance `config.json`
  - shared `default.config.json`
  - built-in defaults
- Keep default replay output rooted at `MULTIBOT/replays` unless the task explicitly changes that behavior.
- Treat `MULTIBOT/sessions` and `MULTIBOT/auth-cache` as the isolated cache locations for `MULTIBOT`.

## Important Directory Roles

- `src/app`
  - app assembly and lifecycle
- `src/config`
  - master config, legacy bot config, normalization, defaults
- `src/runtime`
  - bot lifecycle, feature wiring, runtime summaries/details
- `src/command`
  - command parsing, help output, capability checks
- `src/control`
  - shared services such as broadcast and instance control
- `src/features`
  - bot features; keep cleanup logic complete
- `src/legacy/assn`
  - copied legacy helpers allowed for reuse
- `src/logging`
  - logging, aggregation, console/file coordination
- `flashback-recorder`
  - optional local-only recorder implementation; ignored by Git and absent from the public repository
- `test`
  - backend tests; prefer targeted coverage first
- `BOTS`
  - instance discovery root

## Working Rules By Area

### `src/config`

- Normalize defaults centrally instead of scattering fallbacks across features.
- Keep config backward-compatible where practical.
- When adding config, choose the right layer:
  - `multibot.config.json` for backend-wide behavior
  - `BOTS/<serverDir>/default.config.json` for shared per-server defaults
  - `BOTS/<serverDir>/<botDir>/config.json` for per-instance overrides

### `src/runtime` and `src/features`

- Prefer feature-level gating and attach/cleanup logic over deep `mineflayer` internal hacks.
- Any long-running feature must clean up timers, listeners, intervals, and state on stop/disconnect/restart.
- If a feature is disabled by config/capability, reject commands clearly instead of failing implicitly.

### `src/command`

- When adding or changing a command, also consider:
  - whisper behavior
  - HTTP command execution
  - help text
  - lock/whitelist implications
  - panel-visible replies/logs
- Do not introduce a command path that bypasses existing lock or permission logic.

### `src/logging`

- Preserve existing line formats unless a format change is part of the task.
- Treat these outputs as separate concerns:
  - per-bot console
  - backend main console
  - per-bot log files
  - aggregated server-level files

### `flashback-recorder`

- Treat `MULTIBOT/flashback-recorder` as local-only and never add it to Git.
- If a local recorder fix is needed, patch the ignored local copy without staging it.
- Prefer measurable and toggleable behavior changes.
- Avoid deep protocol/state rewrites unless explicitly required.

## Testing Guidance

- Run the smallest relevant tests first, then broaden only if needed.
- Common full backend test entry:
  - `node --test MULTIBOT/test/*.test.js`
- Useful targeted examples:
  - `node --test MULTIBOT/test/commandDispatcher.test.js`
  - `node --test MULTIBOT/test/botRuntime.test.js`
  - `node --test MULTIBOT/test/recorderFeature.test.js`
- Do not add a new formatter, build tool, or test runner unless explicitly requested.

## Shell And Encoding

- When running PowerShell commands for this project, prefix commands with:
  - `chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;`
- Keep source files as UTF-8 without BOM unless the user explicitly requests an encoding migration.

## Style And Editing Expectations

- Match the existing CommonJS/Node style.
- Keep patches focused; avoid unrelated renames, moves, or formatting churn.
- Preserve current Chinese user-facing wording and log style where practical.
- Preserve existing file encoding and line-ending behavior; do not bulk-normalize files only to change BOM/UTF-8 handling.
- Do not clean up mojibake or unrelated text unless the task is specifically about encoding.
- Avoid inline comments unless they add real value and fit the local style.

## Practical Checklist

Before finishing a runtime-facing change, check:

- whisper control still works
- HTTP command execution still works
- the panel still receives important replies/logs
- stop/restart/disconnect cleanup is complete
- files are still written to the intended directories
