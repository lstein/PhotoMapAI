#!/usr/bin/env python3
"""PreToolUse guard: block edits to the main checkout while it's on master/main.

PhotoMap work must happen in a dedicated git worktree on a
lstein/{fix,feature,chore}/<name> branch (see CLAUDE.md "Worktrees are
mandatory"). It's easy to slide from read-only investigation straight into
editing files on `master` in the main checkout; this hook makes that a hard
stop instead of a convention.

Wired up as a PreToolUse hook on Edit|Write|NotebookEdit. It denies the tool
call (with guidance) only when ALL of these hold:
  * CLAUDE_PROJECT_DIR is set (the main checkout root),
  * the file being written lives inside that main checkout,
  * the main checkout is currently on `master` or `main`.

Edits inside a worktree (which lives outside the main checkout) and edits to
files elsewhere (memory, /tmp, other repos) are never touched. Set
PHOTOMAP_ALLOW_MASTER_EDITS=1 to bypass for an intentional master edit.
"""

import json
import os
import subprocess
import sys


def allow() -> None:
    sys.exit(0)


def main() -> None:
    if os.environ.get("PHOTOMAP_ALLOW_MASTER_EDITS"):
        allow()

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if not project_dir:
        allow()

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        allow()

    tool_input = payload.get("tool_input") or {}
    target = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not target:
        allow()

    abs_target = target if os.path.isabs(target) else os.path.join(project_dir, target)
    project_real = os.path.realpath(project_dir)
    target_real = os.path.realpath(abs_target)

    inside_main = target_real == project_real or target_real.startswith(project_real + os.sep)
    if not inside_main:
        allow()

    try:
        branch = subprocess.run(
            ["git", "-C", project_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        allow()

    if branch not in ("master", "main"):
        allow()

    reason = (
        f"Blocked: editing {target} in the main checkout while it is on '{branch}'.\n"
        "PhotoMap work must happen in a dedicated worktree on a "
        "lstein/{fix,feature,chore}/<name> branch (see CLAUDE.md "
        '"Worktrees are mandatory"). Create one, then edit files under it:\n'
        "  git worktree add -b lstein/fix/<what-it-does> "
        "../photomap-worktrees/lstein-fix-<what-it-does>\n"
        "Intentional master edit? Re-run with PHOTOMAP_ALLOW_MASTER_EDITS=1 set."
    )
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
