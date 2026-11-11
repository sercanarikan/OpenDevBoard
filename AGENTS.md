# OpenDevBoard - Public Edition Agent Guide

This guide applies only to the public `apps/web` React/TypeScript/Vite application and `services/api` Flask/Python service.

## Security and data

- Azure DevOps integration is strictly read-only: use `GET`, except read-only WIQL `POST` requests. Never create, update, delete, approve, or trigger Azure DevOps records.
- Keep PATs and credentials in the backend environment only. Never put secrets in frontend configuration, source files, logs, screenshots, test output, or commits.
- Use synthetic fixture data for tests. Do not access production cache databases, volumes, backups, or live Azure DevOps credentials during local validation.
- Preserve cache transaction, snapshot, and API response compatibility. Document intentional contract changes and cover them with tests.

## Development and verification

- Frontend: run `npm test` and `npm run build` in `apps/web`.
- Backend: run `python -m unittest discover -s services/api -p "test_*.py"` from the repository root.
- E2E: run `npm --prefix scripts run e2e:test` before `npm --prefix scripts run e2e`. The orchestrator executes suites sequentially; do not run fixture stacks concurrently. E2E uses the isolated fixture stack and synthetic data, never a real PAT.
- Preserve all existing assertions. Report only test results that were actually run; a runner that reports zero assertions is not a passing test suite.
- Validate Compose with `docker compose config --quiet`. Never use `docker compose down -v` against a user or production stack.

## Worktrees and generated files

- Do project work in a repository-local Git worktree at `.worktrees/<branch-slug>`. If the active checkout is already a linked worktree, use it instead of nesting another worktree.
- Keep task-specific screenshots, traces, logs, reports, and other generated artifacts under `.local/` inside the active worktree. Use a task-specific subdirectory so outputs are easy to inspect.
- `.worktrees/` and `.local/` are ignored by Git. Do not place project worktrees or generated artifacts in arbitrary home-directory or temporary paths.
- Keep dependency caches and Docker-managed data in their normal tool-managed locations; this rule covers project-specific working files and outputs.

## Repository changes

- Keep the React/TypeScript/Vite and Flask/Python patterns used by neighboring code; add focused tests for behavior changes.
- Keep user-facing documentation accurate and in its existing language. Do not include real customer, organization, project, work-item, or operational measurement data.
- Keep changes focused and use Conventional Commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Never force-push or rewrite history.
