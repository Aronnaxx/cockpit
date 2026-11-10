#!/usr/bin/env python3
"""
cockpit-worktree.py <owner/name> <number> <repo checkout> [--remove]
cockpit-worktree.py --list | --remove-path <worktree>   (every worktree under ~/worktrees, or remove one)
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


def listing():
    """Every worktree under ~/worktrees: {path, name, branch, head, dirty, pr, repo, at}."""
    root = os.path.expanduser("~/worktrees")
    out = []
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        path = os.path.join(root, name)
        if not os.path.exists(os.path.join(path, ".git")):
            continue
        branch = git(path, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
        at = git(path, "log", "-1", "--format=%ct").stdout.strip()
        m = __import__("re").search(r"-pr(\d+)$", name)
        out.append({
            "path": path, "name": name, "branch": branch, "head": git(path, "rev-parse", "--short", "HEAD").stdout.strip(),
            "dirty": len([l for l in git(path, "status", "--porcelain").stdout.splitlines() if l.strip()]),
            "pr": int(m.group(1)) if m else None, "repo": os.path.dirname(common) if common.endswith(".git") else common,
            "at": int(at) * 1000 if at.isdigit() else 0,
        })
    return out


def main():
    if sys.argv[1:2] == ["--list"]:
        print(json.dumps({"worktrees": listing()}))
        return 0
    if sys.argv[1:2] == ["--remove-path"] and len(sys.argv) > 2:
        path = os.path.expanduser(sys.argv[2])
        common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
        repo = os.path.dirname(common)
        branch = git(path, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        r = git(repo, "worktree", "remove", "--force", path)
        if branch.startswith("cockpit-pr-"):
            git(repo, "branch", "-D", branch)
        print(json.dumps({"removed": path} if r.returncode == 0 else {"error": (r.stderr.strip().splitlines() or ["failed"])[-1][:200]}))
        return 0
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
