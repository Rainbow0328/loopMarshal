# Contributing to LoopMarshal

LoopMarshal **0.1.0 Preview** is an early release. Start with the [README](README-EN.md) and [first collaboration guide](FIRST_COLLABORATION.md).

## Prerequisites

- Node.js 22.13+; Node.js 24 is recommended. Core uses built-in SQLite, which is unavailable in Node.js 20.
- pnpm 10.10.0, matching `packageManager` in the root package.
- Git. Windows x64 is required for the current desktop package.
- Third-party tools and model access are needed only for real integration validation; fixture tests do not require model credentials.

## Getting started

```powershell
git clone https://github.com/Rainbow0328/loopMarshal.git
cd loopMarshal
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:core
```

Open `http://127.0.0.1:42688`. For the desktop app, use `pnpm run desktop:dev` instead; it prepares resources and starts its own Core. Do not run both against the same occupied port. Packaging details are in [DESKTOP_BUILD.md](DESKTOP_BUILD.md).

For frontend hot reload, keep Core running and use `pnpm run start:web` in another terminal. The Vite development server defaults to `http://127.0.0.1:5173` and proxies Core requests. Optionally register the CLI with `pnpm run link:cli`; `loopmarshal --version` should print `0.1.0`.

## Development workflow

Create a feature branch and make focused changes. Before submitting:

```powershell
pnpm run format       # Source/config formatting
pnpm run lint         # Format checks and workspace type checks
pnpm run test         # Unit and lifecycle regressions
pnpm run build        # Dependency-ordered builds and injected package synchronization
```

Use the root pnpm build command. This repository enables `injectWorkspacePackages` and synchronizes output after build scripts. Bypassing that lifecycle can leave newly extracted modules missing from dependent packages even when TypeScript succeeds.

CI checks formatting, types, build, and tests on Windows/Linux with Node.js 22 and 24. Browser regressions require an existing Playwright package and browser:

```powershell
node scripts/smoke-product-workflows.mjs --playwright 'path/to/playwright/index.mjs' --browser 'path/to/chrome.exe' --artifacts '.cache/product-workflows'
```

This script uses an isolated temporary project and controlled tool responses. It covers collaboration, live activity, message search, knowledge, native configuration editing, and responsive layouts. It does not prove real-model collaboration. Real vendor validation must name the tools, versions, model source, and session scope; see [compatibility](CLI_COMPATIBILITY.md).

Use conventional commit messages such as `feat:`, `fix:`, `docs:`, and `refactor:`. Describe the user-visible outcome and validation in pull requests. Do not commit credentials, native histories, local databases, configuration backups, or generated installers.

## Module boundaries

| Location                 | Responsibility                                                             |
| ------------------------ | -------------------------------------------------------------------------- |
| `apps/desktop/src`       | Desktop shell, managed Core process, operating-system integration          |
| `apps/web/src/features`  | Feature pages and focused UI components                                    |
| `apps/web/src/lib`       | API access, query keys, shared session subscriptions, content rendering    |
| `apps/core/src/server`   | Authentication, request parsing, route registration by domain              |
| `apps/core/src/services` | Collaboration rules, routing, proxy execution, knowledge and configuration |
| `apps/cli/src`           | Commands, identity, input parsing, waiting workflows and tool setup        |
| `packages/protocol`      | Cross-client types and schemas                                             |
| `packages/store`         | Repositories, transactions and migrations                                  |
| `packages/sdk`           | HTTP and WebSocket clients                                                 |
| `packages/shared`        | Shared configuration and utilities                                         |

Keep business logic in services and persistence in repositories. Avoid adding feature branches back into large page or server entry files. Preserve CSS import order when editing feature styles.

## Adding a coding tool

Choose the capability first: native proxy, configuration editing, discovery, and legacy `start-agent` setup are separate integrations. Do not mark all of them supported because one works.

1. Define tool identity and compatibility in `packages/protocol`; specify unsupported versions and prerequisites.
2. Add installation discovery/readiness and supported native configuration fields in the corresponding Core services.
3. For a proxy, implement explicit session creation/resume, project and history validation, structured completion, cancellation, and uncertainty handling in the native session adapters. Never silently resume the most recent session.
4. Keep member routing and named sending shared with existing tools. Test two native sessions in the same project, history isolation, restarts, invalid IDs, and failed execution.
5. Validate configuration preview/write/restore without exposing secrets or overwriting unknown fields.
6. If legacy `start-agent` support is needed, update `SupportedIde`, `IDE_META`, setup/launch rules in `apps/cli/src/start-agent.ts`, and role instructions under `skills/` separately.
7. Update [CLI_COMPATIBILITY.md](CLI_COMPATIBILITY.md) and [tool configuration guide](FIRST_COLLABORATION.md#工具配置与生效) with the actual evidence level and reproducible validation commands.

## Coding and performance

- Use strict TypeScript, explicit type imports, and ESM where the package uses ESM. Electron entry files remain CommonJS.
- Follow `.editorconfig`, `.gitattributes`, and Prettier. Frontend type checking rejects unused locals and parameters.
- Share session subscriptions rather than opening a WebSocket per panel. Keep notification coalescing and dispose timers/connections when unused.
- Fetch optional panels on demand; avoid forced background polling and synchronous file reads in frequent request paths.
- Keep caches and rendered lists bounded. Current message batching bounds DOM size; the API still returns full history.
- Do not add shell interpolation or `shell: true` for external tool execution. Keep arguments, environment inheritance, and credentials explicit.
- Test behavior and lifecycle boundaries. Pure extraction and formatting do not need tests that merely duplicate the implementation.

## Documentation and screenshots

Keep Chinese and English READMEs aligned with current UI names and implemented capabilities. Document implemented behavior and published preview downloads. Do not claim fixture runs are real-model evidence.

Use [scripts/capture-docs.mjs](scripts/capture-docs.mjs) to regenerate the six quick-start screenshots. See [screenshot instructions](assets/screenshots/README.md). Use only isolated demo data, never private projects or API keys.

## License

Contributions are licensed under [Apache License 2.0](LICENSE).
