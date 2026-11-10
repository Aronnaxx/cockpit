#!/usr/bin/env python3
"""
cockpit-opencode-model.py <folder> <provider/model>
OpenCode's interactive command takes no model flag, so a model for a session is set the way OpenCode reads a project's: a
`.opencode/opencode.jsonc` in the folder it starts in (`{"model": {"providerID", "model"}}`), kept out of git through the
repository's info/exclude. An existing file that is not this script's is left alone. Prints {"ok": true} or {"error": ...}.
"""

import json
import os
import subprocess
import sys

MARK = "_cockpit"


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    folder, model = os.path.expanduser(sys.argv[1]), sys.argv[2]
    provider, _, name = model.partition("/")
    if not name:
        provider, name = "litellm", model
    d = os.path.join(folder, ".opencode")
    path = os.path.join(d, "opencode.jsonc")
    if os.path.exists(path):
        try:
            if not json.load(open(path)).get(MARK):
                print(json.dumps({"error": f"{path} exists and is not Cockpit's; edit its model there"}))
                return 0
        except Exception:
            print(json.dumps({"error": f"{path} exists and is not Cockpit's"}))
            return 0
    os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        json.dump({MARK: True, "model": {"providerID": provider, "model": name}}, f, indent=2)
    ex = subprocess.run(["git", "-C", folder, "rev-parse", "--git-path", "info/exclude"], capture_output=True, text=True).stdout.strip()
    if ex:
        ex = ex if os.path.isabs(ex) else os.path.join(folder, ex)
        os.makedirs(os.path.dirname(ex), exist_ok=True)
        have = open(ex).read() if os.path.exists(ex) else ""
        if ".opencode/" not in have.splitlines():
            with open(ex, "a") as f:
                f.write(("" if have.endswith("\n") or not have else "\n") + ".opencode/\n")
    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
