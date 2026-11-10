#!/usr/bin/env python3
"""
cockpit-walkthrough.py <repo> <scope> <model>
A walkthrough written by a model of the LiteLLM gateway instead of the hub's own Claude. The hub only runs `claude -p` on
haiku, sonnet or opus, so the mod asks it for a walkthrough as usual and then runs this: it waits for the hub's job for
<repo> and <scope> (~/.cache/cockpit/walkthrough/jobs/<key>/), stops the job's Claude before it answers, asks <model> the
job's own prompt, system prompt and schema, and writes the answer where Claude would have (out.json, in `claude -p
--output-format json`'s shape, then `code`). The hub takes it from there: same steps, same hunks, same cache. While it
runs, the job's pid is this one, so the hub's Stop stops it. Prints {key, model} or {error}.
"""

import json
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cockpit_gateway  # noqa: E402

ROOT = os.path.expanduser("~/.cache/cockpit/walkthrough")


def find_job(repo, scope, since):
    """The hub's newest job for the repo and scope, made after `since` (seconds), once its Claude has started."""
    for _ in range(40):
        best = None
        for key in os.listdir(os.path.join(ROOT, "jobs")) if os.path.isdir(os.path.join(ROOT, "jobs")) else []:
            d = os.path.join(ROOT, "jobs", key)
            try:
                meta = json.load(open(os.path.join(d, "meta.json")))
            except Exception:
                continue
            if os.path.realpath(meta.get("repo", "")) != os.path.realpath(repo) or meta.get("scope") != scope:
                continue
            if os.path.exists(os.path.join(d, "code")) or not os.path.exists(os.path.join(d, "pid")):
                continue
            at = os.path.getmtime(os.path.join(d, "meta.json"))
            if at >= since - 5 and (not best or at > best[0]):
                best = (at, key, d)
        if best:
            return best[1], best[2]
        time.sleep(0.5)
    return None, None


def descendants(pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.split("\n")
    kids = {}
    for line in out:
        p = line.split()
        if len(p) == 2:
            kids.setdefault(int(p[1]), []).append(int(p[0]))
    seen, todo = [], [pid]
    while todo:
        x = todo.pop()
        for c in kids.get(x, []):
            seen.append(c)
            todo.append(c)
    return seen


def stop_claude(job):
    """Stops the job's runner (run.sh and its timer) first, so it never writes a code, then its Claude."""
    try:
        pid = int(open(os.path.join(job, "pid")).read().strip())
    except Exception:
        return
    ppid = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    victims = []
    if ppid.isdigit() and int(ppid) > 1:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", ppid], capture_output=True, text=True).stdout
        if "run.sh" in cmd:
            victims += [int(ppid)] + [c for c in descendants(int(ppid)) if c != pid]
    victims += [pid] + descendants(pid)
    for v in victims:
        try:
            os.kill(v, signal.SIGKILL)
        except Exception:
            pass


def main():
    if len(sys.argv) < 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    repo, scope, model = sys.argv[1:4]
    key, job = find_job(repo, scope, time.time())
    if not job:
        print(json.dumps({"error": "the hub started no walkthrough job"}))
        return 1
    stop_claude(job)
    with open(os.path.join(job, "pid"), "w") as f:
        f.write(str(os.getpid()))
    # The pointer names the model the panel shows: this one.
    for p in os.listdir(os.path.join(ROOT, "pointers")):
        path = os.path.join(ROOT, "pointers", p)
        try:
            ptr = json.load(open(path))
            if ptr.get("key") == key:
                ptr["model"] = model
                json.dump(ptr, open(path, "w"))
        except Exception:
            pass
    started = time.time()
    try:
        system = open(os.path.join(job, "system.txt"), encoding="utf-8").read()
        prompt = open(os.path.join(job, "prompt.txt"), encoding="utf-8").read()
        schema = json.load(open(os.path.join(job, "schema.json")))
        ask = system + "\n\nAnswer with one JSON object that follows this JSON schema, and nothing else:\n" + json.dumps(schema)
        text, usage = cockpit_gateway.ask(model, [{"role": "system", "content": ask}, {"role": "user", "content": prompt}], max_tokens=32000, schema=schema)
        obj = cockpit_gateway.as_json(text)
        out = {"type": "result", "subtype": "success", "is_error": False, "result": json.dumps(obj), "structured_output": obj,
               "total_cost_usd": 0, "num_turns": 1, "duration_ms": int((time.time() - started) * 1000),
               "usage": {"input_tokens": usage.get("prompt_tokens", 0), "output_tokens": usage.get("completion_tokens", 0)}, "modelUsage": {model: {}}}
        code = 0
    except Exception as e:
        out = {"type": "result", "subtype": "error", "is_error": True, "result": str(e)[:400]}
        with open(os.path.join(job, "err.txt"), "a") as f:
            f.write(str(e)[:400] + "\n")
        code = 1
    with open(os.path.join(job, "out.json.tmp"), "w") as f:
        json.dump(out, f)
    os.replace(os.path.join(job, "out.json.tmp"), os.path.join(job, "out.json"))
    with open(os.path.join(job, "code.tmp"), "w") as f:
        f.write(str(code))
    os.replace(os.path.join(job, "code.tmp"), os.path.join(job, "code"))
    print(json.dumps({"key": key, "model": model, **({"error": out["result"]} if code else {})}))
    return code


if __name__ == "__main__":
    sys.exit(main())
