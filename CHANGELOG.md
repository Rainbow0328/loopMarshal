# Changelog

## Unreleased — 0.1.0 Preview

### Application control and collaboration

- Expose 70 application actions through a shared CLI/MCP registry, covering collaboration setup, named messages, models, tools/configuration/installations, runtimes, knowledge, discussions, MCP extensions, and preferences.
- Add capability discovery, exact input schemas, structured JSON results, user-to-Host messaging, idempotency conflict checks, and atomic MCP role attachment. Member credentials cannot use the application management entry points.
- Add isolated discussion rooms, reviewed knowledge summaries with source references, and explicit grants for collaboration Hosts to retrieve discussion knowledge.
- Add managed Worker installation directories and preview/apply of compatible saved model settings, with configuration backups and external-change detection.

### Reliability and validation

- Separate application actions by responsibility; share bounded JSON input, error handling, and access checks. Generate and cache JSON Schemas only when requested.
- Handle empty SDK results and malformed upstream responses consistently, preserving HTTP failures and structured permission errors.
- Use production dependency deployment for user packages, normalize workspace versions, include web assets, and avoid hard-link mutation and archive extraction issues.
- Pass 316 automated tests, CLI/MCP application-control integration, seven additional business regression checks, formatting/type checks, and the production build. Independently extract a user package and verify Core, CLI, and MCP startup.
- Integration checks use isolated data, a local deterministic model service, and a native-tool test double; this is not renewed real-model acceptance for every supported CLI.

Desktop, CLI, and package versions remain **0.1.0**. These source changes do not update an existing installer or installed application.

## 0.1.0 Preview — 2026-11-12

The first public preview. Desktop, CLI, and workspace package versions remain **0.1.0**. Windows x64 installers are distributed through GitHub Releases; source updates do not update an installed application.

### Collaboration

- Windows x64 desktop client with a managed local Core, bundled runtime, single-instance behavior, and NSIS packaging into `release/desktop`.
- Project-based sessions with one required Host and optional Workers/Knowledge Keeper. Core-managed model agents, native CLI proxies, and external MCP/CLI waiting members can share a collaboration.
- Central member registry and named routing; new native sessions are created on first execution, while later messages continue the recorded history. Explicit existing-session binding is also supported.
- Durable task delivery, per-native-session serialization, directed reports, cancellation, restart recovery, and manual reconciliation for uncertain outcomes.
- Eleven native tool adapters with different validation levels and prerequisites. See [compatibility](CLI_COMPATIBILITY.md); discovery alone is not real-model validation.
- Session-scoped L1/L2/L3 knowledge, automatically prepared collaboration instructions and tools, and Host queries over recorded member messages.

### Workspace and configuration

- User/Host conversation as the main workspace, with separate members, progress, binding, live activity, and searchable message history views.
- Explicit project/Host requirements, native session creation by default, manual session refresh, and registered external Host discovery.
- Separate installation discovery, native tool configuration, model connections, MCP extensions, and preferences pages.
- Native configuration preview/write, masked secrets, backups, restore, external-change conflicts, and readiness rechecks for supported fields.
- Responsive layouts, Markdown rendering, keyboard/focus behavior, IME-safe sending, retained drafts on failure, and stable history reading.

### Maintainability and performance

- Split workbench panels, message components, configuration editors, CLI input helpers, and server routes by responsibility. Feature styles retain the original cascade order through a small CSS entry.
- Shared per-session WebSocket subscriptions, 100ms notification coalescing, selective knowledge invalidation, and cleaned-up reconnect timers.
- Lazy non-home routes, optional data fetched on demand, indexed/deferred history search, 100-message display batches, and cached Markdown rendering.
- Immediate queue continuation after task completion, asynchronous static file checks, and immutable caching for content-hashed assets.
- Standardized formatting/line endings, frontend unused-code checks, pnpm build synchronization, and CI formatting/type checks.
- Node.js 22.13+ requirement, with Node.js 24 recommended. Core depends on built-in SQLite.

### Documentation

- Rewritten Chinese and English READMEs with current workflows, compatibility boundaries, and six real UI screenshots using isolated demo data.
- Step-by-step [first collaboration guide](FIRST_COLLABORATION.md) covering tool/model setup, required fields, Host/Worker/Keeper creation, the first task, report and knowledge checks, and common blockers.
- Updated session, configuration, desktop, and development guides.
- Repeatable screenshot capture via `scripts/capture-docs.mjs`, without real model calls or changes to user configuration.

### Current boundaries

- Full-history message API remains; UI batching is not server-side pagination.
- No automatic worktree isolation, arbitrary IDE takeover, native terminal embedding/reattachment, or Host identity transfer.
- Configuration coverage and real-model evidence vary by tool. See [native configuration](FIRST_COLLABORATION.md#工具配置与生效) and [compatibility](CLI_COMPATIBILITY.md).
