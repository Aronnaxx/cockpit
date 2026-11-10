"""
The LiteLLM gateway, asked straight: one chat completion, its text (a reasoning model's <think> left out), or JSON.
Shared by the helpers that ask a model of the gateway (walkthroughs, explanations). The base URL is litellm.base_url in
~/.config/cockpit/config.json; the key is this machine's OpenCode one (~/.config/litellm/keys/opencode-*.key), or
litellm.key_file. The key is never printed or cached.
"""

import glob
import json
import os
import re
import urllib.error
import urllib.request

CONFIG = os.path.expanduser("~/.config/cockpit/config.json")


def _cfg():
    try:
        return json.load(open(CONFIG)).get("litellm") or {}
    except Exception:
        return {}


def ask(model, messages, max_tokens=16000, timeout=590, schema=None):
    """The answer's text. `schema`: a JSON schema the answer must follow (sent as response_format; a gateway model that
    refuses it is asked again with plain JSON mode)."""
    ll = _cfg()
    key_file = os.path.expanduser(ll.get("key_file") or next(iter(sorted(glob.glob(os.path.expanduser("~/.config/litellm/keys/opencode-*.key")))), ""))
    key = open(key_file, encoding="utf-8").read().strip() if key_file and os.path.exists(key_file) else ""
    url = (ll.get("base_url") or "http://localhost:4000").rstrip("/") + "/v1/chat/completions"
    formats = [{"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}}, {"type": "json_object"}, None] if schema else [None]
    last = None
    for fmt in formats:
        body = {"model": model, "messages": messages, "max_tokens": max_tokens}
        if fmt:
            body["response_format"] = fmt
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            last = RuntimeError(f"{model}: HTTP {e.code} {e.read().decode(errors='ignore')[:200]}")
            if e.code == 400 and fmt:
                continue
            raise last
        except Exception as e:
            raise RuntimeError(f"{model}: {e}")
        text = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        text = re.sub(r"(?s)<think>.*?</think>", "", text).strip()
        if not text:
            raise RuntimeError(f"{model} gave an empty answer")
        return text, d.get("usage") or {}
    raise last or RuntimeError(f"{model}: no answer")


def as_json(text):
    """The first JSON object in an answer (a model may fence it or talk around it)."""
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        return json.loads(t)
    except Exception:
        pass
    a, b = t.find("{"), t.rfind("}")
    if a >= 0 and b > a:
        return json.loads(t[a : b + 1])
    raise ValueError("the answer is not JSON")
