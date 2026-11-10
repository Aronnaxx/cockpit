#!/usr/bin/env python3
"""
cockpit-rebase.py <owner/name> <number> <repo checkout> <head branch> <head sha> [--push]
Tries to bring a pull request's branch up to date with the base by rebasing (never merging), in a throwaway worktree: your
checkouts and branches are not touched. Without --push it only tells: {"clean": true} when the rebase goes through, or
{"clean": false, "files": [...]} with the files that conflict. With --push, and only when clean, it force-pushes the
rebased branch (`--force-with-lease` against the sha given) and prints {"clean": true, "pushed": true}.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=600)


def main():
    if len(sys.argv) < 6:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    slug, number, repo, branch, sha = sys.argv[1], sys.argv[2], os.path.expanduser(sys.argv[3]), sys.argv[4], sys.argv[5]
    push = "--push" in sys.argv
    if not os.path.exists(os.path.join(repo, ".git")):
        print(json.dumps({"error": f"{repo} is not a git checkout"}))
        return 0
    base = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.strip().replace("origin/", "") or "main"
    f = git(repo, "fetch", "origin", base, f"+pull/{number}/head:refs/cockpit/pr-{number}")
    if f.returncode != 0:
        print(json.dumps({"error": (f.stderr.strip().splitlines() or ["git fetch failed"])[-1][:200]}))
        return 0
    head = git(repo, "rev-parse", f"refs/cockpit/pr-{number}").stdout.strip()
    if push and head != sha:
        print(json.dumps({"error": "The branch moved since it was read; refresh and try again"}))
        return 0
    root = os.path.expanduser("~/worktrees")
    os.makedirs(root, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".rebase-", dir=root)
    try:
        w = git(repo, "worktree", "add", "--detach", tmp, head)
        if w.returncode != 0:
            print(json.dumps({"error": (w.stderr.strip().splitlines() or ["git worktree add failed"])[-1][:200]}))
            return 0
        r = git(tmp, "rebase", f"origin/{base}")
        if r.returncode != 0:
            files = [l for l in git(tmp, "diff", "--name-only", "--diff-filter=U").stdout.splitlines() if l]
            git(tmp, "rebase", "--abort")
            # A rebase stops at its first conflicting commit; a merge of the two tips names every file in conflict.
            mt = git(repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", head, f"origin/{base}").stdout.splitlines()
            for line in mt[1:]:
                if not line:
                    break
                if line not in files:
                    files.append(line)
            print(json.dumps({"clean": False, "files": files}))
            return 0
        if not push:
            print(json.dumps({"clean": True}))
            return 0
        p = git(tmp, "push", f"--force-with-lease=refs/heads/{branch}:{sha}", "origin", f"HEAD:refs/heads/{branch}")
        if p.returncode != 0:
            print(json.dumps({"error": (p.stderr.strip().splitlines() or ["git push failed"])[-1][:240]}))
            return 0
        print(json.dumps({"clean": True, "pushed": True}))
        return 0
    finally:
        git(repo, "worktree", "remove", "--force", tmp)
        shutil.rmtree(tmp, ignore_errors=True)
        git(repo, "worktree", "prune")


if __name__ == "__main__":
    sys.exit(main())
