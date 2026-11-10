#!/usr/bin/env python3
"""
cockpit-slots.py
The local model servers' request slots, for OpenCode's card on the Usage page: OpenCode has no account limit, but each GPU
box serves a fixed number of requests at once. Read from a sparkDash (`usage.slots` in ~/.config/cockpit/config.json:
{"url": "http://127.0.0.1:5555", "via": "<machine sparkDash runs on, asked through `hc exec --on`>", "sparks": ["id", ...]}).
Prints {"hosts": [{id, name, online, model, quant, context, active, total, running, waiting, tps, prefill_tps}], "at"} or {"error"}.
"""

import json
import os
import subprocess
import sys
import time

CONFIG = os.path.expanduser("~/.config/cockpit/config.json")


def get(url, via):
    argv = (["hc", "exec", "--on", via] if via else []) + ["curl", "-s", "-m", "6", url]
    r = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError((r.stderr.strip().splitlines() or [f"no answer from {url}"])[-1][:200])
    return json.loads(r.stdout)


def main():
    try:
        cfg = (json.load(open(CONFIG)).get("usage") or {}).get("slots") or {}
    except Exception:
        cfg = {}
    if not cfg.get("url"):
        print(json.dumps({"error": "set usage.slots.url (a sparkDash) in the cockpit config"}))
        return 1
    base, via = cfg["url"].rstrip("/"), cfg.get("via")
    try:
        ids = cfg.get("sparks") or [s["id"] for s in get(f"{base}/api/sparks", via).get("sparks", [])]
        hosts = []
        for sid in ids:
            try:
                d = get(f"{base}/api/sparks/{sid}/metrics", via)
            except Exception as e:
                hosts.append({"id": sid, "name": sid, "online": False, "error": str(e)[:120]})
                continue
            for l in ((d.get("metrics") or {}).get("llm") or [])[:1]:
                hosts.append({"id": sid, "name": d.get("name") or sid, "online": bool(d.get("online")) and bool(l.get("available")), "model": l.get("modelDisplayName") or l.get("modelId"), "quant": l.get("modelQuant"),
                              "context": l.get("contextLength"), "active": l.get("slotsActive") or 0, "total": l.get("slotsTotal") or 0, "running": l.get("requestsRunning") or 0, "waiting": l.get("requestsWaiting") or 0,
                              "tps": l.get("generationTps") or 0, "prefill_tps": l.get("prefillTps") or 0})
            if not (d.get("metrics") or {}).get("llm"):
                hosts.append({"id": sid, "name": d.get("name") or sid, "online": bool(d.get("online")), "model": None, "active": 0, "total": 0})
        print(json.dumps({"hosts": hosts, "at": int(time.time() * 1000)}))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)[:300]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
