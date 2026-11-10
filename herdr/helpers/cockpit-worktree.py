#!/usr/bin/env python3
"""
cockpit-worktree.py <owner/name> <number> <repo checkout> [--remove]
A git worktree of a pull request's head, to read and run its code beside your own checkout: fetches `pull/<number>/head`
into the local branch `cockpit-pr-<number>` and adds the worktree at ~/worktrees/<name>-pr<number> (the one there is reused).
--remove deletes the worktree and the branch. Prints JSON {path} or {error}. Your own branch and checkout are not touched.
"""

import json
import os
import subprocess
import sys


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=300)


def main():
    if len(sys.argv) < 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    slug, number, repo = sys.argv[1], sys.argv[2], os.path.expanduser(sys.argv[3])
    name = slug.split("/")[1]
    branch = f"cockpit-pr-{number}"
    path = os.path.expanduser(f"~/worktrees/{name}-pr{number}")
    if not os.path.isdir(os.path.join(repo, ".git")) and not os.path.isfile(os.path.join(repo, ".git")):
        print(json.dumps({"error": f"{repo} is not a git checkout"}))
        return 0
    if "--remove" in sys.argv:
        git(repo, "worktree", "remove", "--force", path)
        git(repo, "branch", "-D", branch)
        print(json.dumps({"removed": path}))
        return 0
    if os.path.isdir(path):
        # Reuse it, brought to the pull request's latest head.
        f = git(repo, "fetch", "origin", f"+pull/{number}/head:{branch}")
        if f.returncode == 0:
            git(path, "reset", "--hard", branch)
        print(json.dumps({"path": path, "reused": True}))
        return 0
    f = git(repo, "fetch", "origin", f"+pull/{number}/head:{branch}")
    if f.returncode != 0:
        print(json.dumps({"error": (f.stderr.strip().splitlines() or ["git fetch failed"])[-1][:200]}))
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    w = git(repo, "worktree", "add", path, branch)
    if w.returncode != 0:
        print(json.dumps({"error": (w.stderr.strip().splitlines() or ["git worktree add failed"])[-1][:200]}))
        return 0
    print(json.dumps({"path": path}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
