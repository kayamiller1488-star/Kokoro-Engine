#!/usr/bin/env python3
"""Measure the voice pipeline stage by stage. Baseline: baseline/latency-2026-11-22.md.

    python baseline/measure-latency.py            # ear, brain, mouth
    python baseline/measure-latency.py --app      # also the app-side turn (needs CDP on 9222)

Nothing here writes to the services; every call is a normal request they already serve.
Measure with the machine idle if the numbers are meant to be comparable later.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.request

EARS = "http://127.0.0.1:9882/transcribe"
MOUTH = "http://127.0.0.1:9881/v1/audio/speech"
BRAIN = "http://127.0.0.1:8091/v1/chat/completions"
DEBUG_PORT = 9222


def _post(url: str, data: bytes, headers: dict, timeout: int = 300) -> tuple[float, bytes]:
    start = time.perf_counter()
    body = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=timeout).read()
    return (time.perf_counter() - start) * 1000, body


def tts(text: str, voice: str = "kana") -> bytes:
    payload = json.dumps({"model": "tts-1", "input": text, "voice": voice}).encode()
    return _post(MOUTH, payload, {"Content-Type": "application/json"})[1]


def summarise(label: str, samples: list[float]) -> None:
    print(f"  {label:34s} median {statistics.median(samples):6.0f} ms   "
          f"min {min(samples):5.0f}   max {max(samples):5.0f}   n={len(samples)}")


def measure_ear(rounds: int = 8) -> None:
    japanese = tts("お疲れ様です", "kana")
    english = tts("So the right word is good evening.", "sasha")
    ja, en = [], []
    for _ in range(rounds):
        ja.append(_post(EARS + "?language=ja", japanese, {"Content-Type": "application/octet-stream"})[0])
        en.append(_post(EARS, english, {"Content-Type": "application/octet-stream"})[0])
    print("EAR (warm)")
    summarise("japanese pinned (whisper)", ja)
    summarise("english (sensevoice)", en)


def system_prompt() -> str:
    import pathlib
    path = pathlib.Path.home() / "AppData/Roaming/com.chyin.kokoro/character_runtime_backend.json"
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("system_prompt", "")
    except OSError:
        return ""


def measure_brain(rounds: int = 5) -> None:
    system = system_prompt()
    questions = ["こんばんは", "今日はいい天気だね", "何してるの", "ありがとう", "元気？"][:rounds]
    full = []
    for question in questions:
        payload = json.dumps({
            "model": "local",
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": question}],
            "temperature": 0.6, "max_tokens": 80,
        }).encode()
        full.append(_post(BRAIN, payload, {"Content-Type": "application/json"})[0])
    print("BRAIN (llama.cpp)")
    summarise("full reply", full)


def measure_mouth(rounds: int = 6) -> None:
    print("MOUTH (kokoro-onnx)")
    for label, text, voice in (
        ("6 chars japanese", "どういたしまして", "kana"),
        ("20 chars japanese", "おはよう、秋さん！今日も元気？", "kana"),
        ("24 chars english", "So the right word is good evening.", "sasha"),
    ):
        payload = json.dumps({"model": "tts-1", "input": text, "voice": voice}).encode()
        samples = [_post(MOUTH, payload, {"Content-Type": "application/json"})[0] for _ in range(rounds)]
        summarise(label, samples)


def measure_app(rounds: int = 4) -> None:
    """Text submitted -> her first audio sample. Needs the app with --remote-debugging-port."""
    try:
        from websockets.sync.client import connect
    except ImportError:
        print("  (websockets not installed; skipping the app-side turn)")
        return
    targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=10).read())
    host = next((t for t in targets if (t.get("url") or "").startswith("http://mod.localhost")), None)
    if not host:
        print("  (mod frame not found; is the app running with the debug port?)")
        return
    samples = []
    with connect(host["webSocketDebuggerUrl"], max_size=8_000_000) as ws:
        def call(expr: str):
            ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
            while True:
                message = json.loads(ws.recv())
                if message.get("id") == 1:
                    return message.get("result", {}).get("result", {}).get("value")

        for question in ["こんばんは", "今日はどう？", "何してるの", "おやすみ"][:rounds]:
            before = call("window.__vaVoice.playbackStartedAt || 0")
            start = time.perf_counter()
            call(f"Kokoro.invoke('mod_send_message',{{message:{json.dumps(question)}}})")
            while time.perf_counter() - start < 25:
                if (call("window.__vaVoice.playbackStartedAt || 0") or 0) != before:
                    samples.append((time.perf_counter() - start) * 1000)
                    break
                time.sleep(0.03)
            time.sleep(1.2)
    print("APP (text in -> first audio)")
    summarise("turn", samples)


if __name__ == "__main__":
    measure_ear()
    measure_brain()
    measure_mouth()
    if "--app" in sys.argv:
        measure_app()
