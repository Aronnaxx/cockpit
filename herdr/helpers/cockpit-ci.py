#!/usr/bin/env python3
"""
cockpit-ci.py <buildkite build url> [--retry-failed]
A Buildkite build's jobs, and the failed ones by name, through the `bk` CLI; with --retry-failed it retries each failed job
(not the whole build). Prints JSON {state, number, url, failed: [{id, name, state}], running, passed, retried}.
"""

import json
import re
import subprocess
import sys

FAILED = {"failed", "timed_out", "timing_out"}


def clean(name):
    return re.sub(r"\s+", " ", re.sub(r":[a-z0-9_+-]+:", "", name or "")).strip()


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    m = re.match(r"https://buildkite\.com/([^/]+)/([^/]+)/builds/(\d+)", sys.argv[1])
    if not m:
        print(json.dumps({"error": "not a Buildkite build URL"}))
        return 0
    org, pipeline, number = m.groups()
    r = subprocess.run(["bk", "build", "view", number, "-p", pipeline, "-o", org, "--output", "json"], capture_output=True, text=True, timeout=60)
    try:
        build = json.loads(r.stdout)
    except Exception:
        print(json.dumps({"error": (r.stderr.strip().splitlines() or ["bk could not read the build"])[-1][:200]}))
        return 0
    jobs = [j for j in build.get("jobs") or [] if j.get("type") == "script"]
    failed = [{"id": j["id"], "name": clean(j.get("name") or j.get("step_key")), "state": j.get("state")} for j in jobs if j.get("state") in FAILED]
    out = {
        "state": build.get("state"), "number": int(number), "url": sys.argv[1], "failed": failed,
        "running": sum(1 for j in jobs if j.get("state") in ("running", "scheduled", "assigned", "accepted", "waiting")),
        "passed": sum(1 for j in jobs if j.get("state") == "passed"), "retried": 0,
    }
    if "--retry-failed" in sys.argv:
        for j in failed:
            p = subprocess.run(["bk", "job", "retry", j["id"], "-y"], capture_output=True, text=True, timeout=60)
            if p.returncode == 0:
                out["retried"] += 1
            else:
                out.setdefault("errors", []).append((p.stderr.strip().splitlines() or ["retry failed"])[-1][:160])
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
