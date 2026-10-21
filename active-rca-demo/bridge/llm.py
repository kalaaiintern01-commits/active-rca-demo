"""
Reasoning engines.

ClaudeSubscription - calls the locally installed Claude Code CLI in headless mode (`claude -p`).
    It authenticates with the Claude subscription you are logged into (`claude auth login` /
    `/login`), so no API key is involved: ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are removed
    from the child environment so the CLI cannot silently fall back to metered API billing.
    --safe-mode + --tools "" give a bare model call: no CLAUDE.md, MCP servers, plugins, hooks or
    tools, and the answer is forced into the pdm.rca.v1 JSON schema (--json-schema).

MockEngine - deterministic nearest-signature matcher. NOT an LLM; used for offline tests and as a
    fallback when the subscription is unavailable. Every diagnosis is tagged with the engine that
    produced it so the dashboard never passes mock output off as Claude's.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def rca_schema(causes: list[str], tests: list[str]) -> dict:
    """pdm.rca.v1 diagnosis body. Enums are built per call so only legal causes/tests can come back."""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary", "causes", "next_test", "test_rationale", "stop_reason", "severity", "action"],
        "properties": {
            "summary": {"type": "string"},
            "causes": {
                "type": "array", "minItems": 1, "maxItems": 5,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["cause", "p", "evidence"],
                    "properties": {
                        "cause": {"type": "string", "enum": causes},
                        "p": {"type": "number", "minimum": 0, "maximum": 1},
                        "evidence": {"type": "string"},
                    },
                },
            },
            "next_test": {"type": "string", "enum": ["none"] + tests},
            "test_rationale": {"type": "string"},
            "stop_reason": {"type": "string", "enum": ["need_test", "confident", "no_useful_test", "healthy"]},
            "severity": {"type": "string", "enum": ["info", "watch", "alarm"]},
            "action": {"type": "string"},
        },
    }


def find_claude() -> str:
    """The native claude executable. Calling it directly avoids cmd.exe re-quoting the JSON schema."""
    env = os.environ.get("CLAUDE_EXE")
    if env and Path(env).exists():
        return env
    cands = [Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
             Path.home() / ".local/bin/claude.exe", Path.home() / ".claude/local/claude.exe"]
    for c in cands:
        if c.exists():
            return str(c)
    w = shutil.which("claude")
    if w:
        return w
    raise FileNotFoundError("Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code), "
                            "run `claude` once and /login with your subscription, or set CLAUDE_EXE.")


class ClaudeSubscription:
    name = "claude"

    def __init__(self, model: str = "opus", effort: str = "medium", timeout_s: int = 300):
        self.exe = find_claude()
        self.model, self.effort, self.timeout = model, effort, timeout_s
        self.system = (HERE / "prompts" / "system.md").read_text(encoding="utf-8")
        self.workdir = tempfile.mkdtemp(prefix="arca-llm-")      # empty cwd: nothing to pick up as context

    @property
    def label(self):
        return f"claude-subscription:{self.model}"

    def diagnose(self, prompt: str, schema: dict) -> tuple[dict, dict]:
        env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
        args = [self.exe, "-p", "--safe-mode", "--tools", "", "--no-session-persistence",
                "--model", self.model, "--effort", self.effort,
                "--output-format", "json", "--json-schema", json.dumps(schema, separators=(",", ":")),
                "--system-prompt", self.system]
        t0 = time.time()
        p = subprocess.run(args, input=prompt, capture_output=True, text=True, encoding="utf-8",
                           timeout=self.timeout, cwd=self.workdir, env=env)
        dt = time.time() - t0
        try:
            out = json.loads(p.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"claude exited {p.returncode}: {(p.stderr or p.stdout)[:400]}")
        if out.get("is_error") or out.get("subtype") != "success" or "structured_output" not in out:
            raise RuntimeError(f"claude error: {str(out.get('result') or out)[:400]}")
        u = out.get("usage", {})
        meta = {"engine": self.label, "latency_s": round(dt, 1), "api_ms": out.get("duration_api_ms"),
                "in_tokens": (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                              + u.get("cache_creation_input_tokens", 0)),
                "out_tokens": u.get("output_tokens"), "turns": out.get("num_turns")}
        return out["structured_output"], meta


class MockEngine:
    """Nearest reference signature in log-ratio space. Deterministic, instant, not an LLM."""
    name = "mock"
    label = "mock-rule-based (not an LLM)"
    FEATS = ["rms", "b0", "b1", "b2", "b3", "bhf", "a1x", "a2x", "app", "cur_rms"]

    def __init__(self, signatures: dict, manifest: dict):
        self.sig, self.man = signatures, manifest

    def diagnose(self, prompt: str, schema: dict) -> tuple[dict, dict]:
        ev = json.loads(prompt[prompt.index("{"):])
        src = ev["machine"]["src"]
        truth_map = self.man["sources"][src]["truth"]
        obs = {ev["now"]["op"]: {f: r["ratio"] for f, r in ev["now"]["features"].items() if r.get("ratio")}}
        for t in ev["tests"]:
            if t["status"] == "done":
                obs[t["op"]] = {f: r["ratio"] for f, r in t["features"].items() if r.get("ratio")}
        allowed = schema["properties"]["next_test"]["enum"][1:]
        if src not in self.sig:                     # S3: no signature library -> simple physics rules
            z = {f: r.get("z", 0) or 0 for f, r in ev["now"]["features"].items()}
            if max(abs(v) for v in z.values()) < 3:
                causes = [("healthy", 0.85), ("unknown", 0.15)]
            elif z.get("temp", 0) > 3 and abs(z.get("cur_rms", 0)) < 3:
                causes = [("thermal_drift_wear", 0.6), ("cooling_failure", 0.25), ("bearing_or_brush_wear", 0.15)]
            else:
                causes = [("electrical_overload", 0.5), ("thermal_drift_wear", 0.3), ("unknown", 0.2)]
            nt = "none"
        else:
            scores = {}
            for code, ops in self.sig[src].items():
                d, n = 0.0, 0
                for op, o in obs.items():
                    s = ops.get(op, {})
                    for f in self.FEATS:
                        if o.get(f) and s.get(f):
                            d += (math.log(o[f]) - math.log(s[f])) ** 2; n += 1
                if n:
                    scores[truth_map[code]] = d / n
            w = {c: math.exp(-v / 0.05) for c, v in scores.items()}
            tot = sum(w.values()) or 1.0
            ranked = sorted(((c, v / tot) for c, v in w.items()), key=lambda kv: -kv[1])[:4]
            causes = ranked
            nt = "none"
            if ranked[0][1] < 0.8 and len(ranked) > 1 and allowed:
                inv = {v: k for k, v in truth_map.items()}
                a, b = self.sig[src][inv[ranked[0][0]]], self.sig[src][inv[ranked[1][0]]]
                gap = {op: sum(abs(math.log(a[op][f]) - math.log(b[op][f])) for f in self.FEATS
                               if a.get(op, {}).get(f) and b.get(op, {}).get(f)) for op in allowed}
                nt = max(gap, key=gap.get) if gap else "none"
        top = causes[0]
        out = {
            "summary": f"Nearest reference signature: {top[0]} ({top[1]:.0%}).",
            "causes": [{"cause": c, "p": round(p, 3), "evidence": "log-ratio distance to reference signature"}
                       for c, p in causes],
            "next_test": nt,
            "test_rationale": "largest signature gap between the top two candidates" if nt != "none" else "",
            "stop_reason": "healthy" if top[0] == "healthy" else ("need_test" if nt != "none" else
                                                                  ("confident" if top[1] >= 0.8 else "no_useful_test")),
            "severity": "info" if top[0] == "healthy" else ("alarm" if top[1] >= 0.8 else "watch"),
            "action": "rule-based placeholder - run with the Claude engine for a reasoned recommendation",
        }
        return out, {"engine": self.label, "latency_s": 0.0}
