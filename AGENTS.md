# Agent collaboration

- Read this file and `AI_HANDOFF.md` before changing the repository.
- Inspect the current branch, status, diff, and recent commits before editing.
- Preserve uncommitted work and do not push, reset, rebase, or delete branches without explicit authorization.
- Update `AI_HANDOFF.md` after meaningful code changes, failed attempts, discoveries, and verification results.
- Do not claim success without direct verification.
- The PowerShell package and manifest live in `skills/agent-delegation-tools/`; call wrappers from the repository root with `.\skills\agent-delegation-tools\scripts\<name>.ps1`. Personal skill copies are managed by `install.ps1`.

## Automatic commits (user authorization, 2026-10-05)

- The user has authorized automatic local commits for all projects. After completing a task and appropriate verification, commit the task changes without asking for confirmation again; do not create empty commits.
- Review the diff and preserve existing work. Include unrelated pre-existing changes only when the user explicitly requests committing them. Never commit secrets, credentials, or personal runtime data.
- This standing authorization covers local commits only. Push, release, merge, rebase, reset, force-push, branch deletion, and destructive operations still require explicit authorization.
- Record what was verified and any unverified behavior in `AI_HANDOFF.md`; never present a commit as proof that functionality works.
