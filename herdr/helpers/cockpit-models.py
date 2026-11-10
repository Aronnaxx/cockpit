#!/usr/bin/env python3
"""
cockpit-models.py
The models of the LiteLLM gateway (litellm.base_url in ~/.config/cockpit/config.json; the key from $LITELLM_API_KEY or the
file litellm.key_file), as a sorted JSON list of ids, kept for ten minutes in ~/.cache/cockpit/models.json.
"""

import json
import os
import sys
import time
import urllib.request

CACHE = os.path.expanduser("~/.cache/cockpit/models.json")


def main():
    try:
        old = json.load(open(CACHE))
        if time.time() - old.get("at", 0) < 600 and old.get("models"):
            print(json.dumps(old))
            return 0
    except Exception:
        old = None
    try:
        ll = (json.load(open(os.path.expanduser("~/.config/cockpit/config.json"))).get("litellm") or {})
    except Exception:
        ll = {}
    if not ll.get("base_url"):
        print(json.dumps({"models": [], "error": "set litellm.base_url in the cockpit config"}))
        return 0
    key = os.environ.get("LITELLM_API_KEY", "")
    kf = os.path.expanduser(ll.get("key_file") or "")
    if not key and kf and os.path.exists(kf):
        key = open(kf, encoding="utf-8").read().strip()
    try:
        req = urllib.request.Request(ll["base_url"].rstrip("/") + "/v1/models", headers={"Authorization": f"Bearer {key}"} if key else {})
        with urllib.request.urlopen(req, timeout=8) as r:
            ids = sorted({m["id"] for m in json.load(r).get("data") or [] if m.get("id")}, key=str.lower)
    except Exception as e:
        print(json.dumps({**(old or {"models": []}), "error": str(e)[:160]}))
        return 0
    out = {"at": int(time.time() * 1000), "models": ids}
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE + ".tmp", "w") as f:
        json.dump(out, f)
    os.replace(CACHE + ".tmp", CACHE)
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
