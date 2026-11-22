# Plan: cloud brain (OpenCode Zen) behind the same voice loop

Status: **proposal, nothing implemented.** Every number below was measured on this machine today.

## Answer to "the API settings have no opencode entry"

That is correct: the shell ships five provider types only — `openai`, `anthropic`, `codex_runtime`,
`ollama`, `llama_cpp` (see `llm_config.json`). There is no "opencode" entry and adding one is not a
settings-UI action.

It is still possible, because `openai` is not "OpenAI the company" — it is a generic
OpenAI-compatible client with an editable `base_url` and `api_key`. The cloud endpoint is
OpenAI-compatible too. What stops a naive `base_url` swap is not the provider type, it is three
headers/params the endpoint requires.

## What the endpoint actually demands (measured)

| finding | evidence |
|---|---|
| Base URL | `https://opencode.ai/zen/go/v1` (from `auth.json` `opencode-go`) |
| Auth | `Authorization: Bearer $OPENCODE_GO_API_KEY` (key lives in `hermes/.env`, 51 chars) |
| Bot gate | bare `python-urllib`/no-UA got `HTTP 403 error code: 1010` (Cloudflare); any real UA passes |
| Session header | without it: `400 MissingSessionID — Request is missing x-opencode-session`; a fresh `uuid4()` per request works |
| glm-5.3-flash is a reasoning model | it fills `reasoning_content` first and returns `content: null` if the budget runs out — her 6.3k persona burned all 300 tokens and emitted `"う"` |
| `thinking: {"type":"disabled"}` works | 1909 ms, 28 output tokens, no reasoning, natural Japanese |

The shell's Rust client sends neither `x-opencode-session` nor a `thinking` flag, so a direct
`base_url` swap would return empty replies (null content) even if Cloudflare let it through.

## Measured latency, cloud vs local (idle machine, her real persona, Japanese question)

| brain | first spoken token (streaming) | full reply | output tokens |
|---|---|---|---|
| Local 4B (llama.cpp, current) | — (not streamed; 191 ms to full reply) | **191 ms** | ~22 |
| glm-5.3-flash, thinking **on** | 2947 ms | 3457 ms (at 900 tok) | 181 |
| glm-5.3-flash, thinking **off** | **1390 ms** | **1909 ms** | 28 |
| mimo-v2.6-flash | — | 4383 ms | 59 |
| deepseek-v4.1-flash | — | 3558 ms | 82 |

So the honest trade: **the cloud brain costs about +1.7 s per turn** (turn total ~1.8 s → ~3.5 s) and
buys markedly better Japanese, plus it frees ~8.1 GB of VRAM.

Route choice inside the endpoint, if kept, is not a config detail — it is the difference between
1.9 s and 3.5 s per reply.

## Three routes

### A. Local relay (recommended)
A ~120-line service on `127.0.0.1:8092`, OpenAI-compatible, that the shell talks to exactly like the
local brain. It adds the three missing pieces and logs what the shell cannot tell us.

```
shell ──POST /v1/chat/completions──► relay :8092 ──► opencode.ai/zen/go/v1
                                     + Bearer (from hermes/.env)
                                     + x-opencode-session: uuid4 per request
                                     + User-Agent: kokoro-engine/0.2.7
                                     + thinking:{type:disabled}  (glm only)
                                     + max_tokens floor
                                     logs: ttft, total, prompt/out tokens, model
```

Why this wins:
- no shell code changes, no rebuild, and switching back to local is a one-line config edit
- per-model knobs (thinking off only for glm) stay in one place
- it can route by the model name the shell already sends, so A/B is `model: "cloud"` vs `"local"`
- it can strip `reasoning_content` so nothing downstream ever sees it
- it can cap spend (max_tokens, per-hour counter)

### B. Direct `base_url` swap (not viable as-is)
Point the `openai` provider at the Zen URL. Blocked by the missing session header and by
thinking-on-by-default; would need shell code anyway, so it is strictly worse than A.

### C. Patch the shell's LLM client (only if the relay ever becomes a bottleneck)
Add the headers/params in Rust inside the provider layer. More power (streaming per sentence), but it
means touching the provider code and rebuilding; the relay gets us the same measurement first.

## Steps for route A

1. Write `brain-relay.py` (already proven pattern: an earlier relay ran on :8092 this session).
2. Point the `openai` provider's `base_url` at `http://127.0.0.1:8092/v1`, keep the same key field.
3. Measure with `baseline/measure-latency.py --app` so the cloud numbers sit next to the local ones in
   the same table.
4. Compare quality on the cases that matter for her: greetings, her `OUTPUT RULES` (no romaji, no
   Chinese), name/honorific handling, and the "correct only when sure" rule.
5. Decide. Switching back is one `base_url` line; nothing else in the build changes.

## Risks and open questions

- **Cost**: 1531 prompt + 28 completion tokens per turn with her persona (prompt dominates). Price per
  1k tokens for glm-5.3-flash is not something I have measured — I can only report tokens. At a turn
  every 10 s of conversation this is a real per-hour number; worth pricing before leaving it on.
- **Latency** roughly doubles. If that matters more than language quality, stay local.
- **Character drift**: a frontier model follows the persona *more* literally, including the abrupt
  style in it; expect her to sound different even though nothing in the persona changed.
- **Offline**: cloud dies without network; keep local as the fallback provider rather than replacing it.
- **Privacy**: every turn's text leaves the machine, including whatever he says about himself.
- **Thinking flag** is undocumented here; if the vendor changes it, replies go `content: null` and she
  goes silent. The relay should detect null content and retry once with a bigger budget.

## Decision needed from the owner

1. Route A (relay) — yes/no.
2. Default model: glm-5.3-flash with thinking off, or try mimo/deepseek first.
3. Whether the relay should default to **cloud** or keep **local** as the default and flip only for
   experiments.
