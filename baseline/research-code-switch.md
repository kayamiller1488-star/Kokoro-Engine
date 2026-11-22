# Research: mixed-language sentences (code-switching) for the ear

Prepared 2026-11-22 night, for work on 2026-11-23. **Nothing here is wired into the live stack** —
the current ear works and stays as it is until an option below is chosen and tested.

## The problem, as it actually happens

He is learning, so the natural sentence is an English frame around a quoted foreign word:

> "what is 無事で mean"      → ear heard `buchi der`  → she guessed wrong
> "what is nina (你呢) mean" → ear heard `Nna Min`    → she replied "你是问 niàn míng?"

This is **intra-sentential code-switching**. The quoted word is 1–4 syllables, pronounced
non-natively, inside a sentence the model has already decided is English. Every layer is biased
against it: the language decision is made once for the utterance, and a short foreign token has
too little audio to overturn that decision.

Logged evidence from tonight (ears.log):

```
whisper second opinion: '你叫什么？' -> 'にちゃうしまー'      # ja pass on Mandarin
2.42s audio -> 8 chars | 'K banwa.'                        # konbanwa as English
```

## What the research says

| finding | source | consequence here |
|---|---|---|
| Fixed-language decoding guarantees the failure: the decoder "cannot return a word it has been told does not exist" | Soniox, code-switching wiki | pinning the ear's language is not the fix; it moves the damage |
| Whole-utterance language detection also fails; language must be resolved **per token** | same | our `SENSEVOICE_LANGUAGES` hint is utterance-level by construction |
| Contextual biasing (hotwords) exists in sherpa-onnx **only for transducer models**; "all other models don't support hotwords" | sherpa-onnx hotwords docs | SenseVoice is CTC-based — hotword boosting is not available to us without changing the model |
| Whisper can be biased with an `initial_prompt`, but rare-word gains are modest zero-shot; the 45 % gains in the literature come from fine-tuning | arXiv 2502.11572 | worth one experiment, not a plan |
| Vendors now ship per-token LID as the real answer (Soniox, Gladia) | vendor docs | the thorough fix is a different ASR service, with cost + latency + cloud dependency |

## What I tested tonight

### Attempt 1 — ask the model to resolve it (fails)

Feed a frontier model her previous message plus the garbled question, with an explicit rule to
match phonetically. Two cases, plus a deliberately meaningless control word:

| case | without rule | with rule |
|---|---|---|
| "what is **nina** mean" (she said 米饭！你呢？) | "Do you mean nín hǎo?" ✗ | "nina isn't a word I said, say it again?" ✗ |
| "what is **buchi der** mean" (she said 今日は無事でよかったね) | "did you mean oishii?" ✗ | "You probably mean 不客气 (bú kè qi)" ✗ |
| control "zorblatt" | correctly refuses | correctly refuses |

**Conclusion: prompt engineering cannot do phonetic matching.** The model guesses a plausible
near-neighbour instead of the actual word, which is worse than silence for a learner.

### Attempt 2 — deterministic phonetic repair against her last message (works)

The insight that makes this tractable: **the word he asks about is almost always something she
said one message ago.** So the search space is one sentence, not a dictionary.

Prototype (`va-ears/phonetic_repair.py`): every 1–4 character window of her last message, read
both ways (pinyin via `pypinyin`, Japanese kana/romaji via `pykakasi`), compared against the odd
Latin token from the transcript with a phrase-aware similarity (digraph folding, doubled letters,
voiced/unvoiced drift), accepted only above a score **and** a margin over the runner-up.

| heard | her previous message | result | score |
|---|---|---|---|
| "what is **nina** mean" | 米饭！你呢？ | → **你呢** (ni ne) | 0.75 |
| "What is **nina min** mean" | 米饭！你呢？ | → **你呢** | 0.75 |
| "what is **mifan** mean" | 米饭！你呢？ | → **米饭** (mi fan) | 1.00 |
| "what is **buchi der** mean" | 今日は無事でよかったね。 | → **無事** (buji) | 0.75 |
| "what does **buji de** mean" | 今日は無事でよかったね。 | → **無事** | 1.00 |
| "what is **zorblatt** mean" | 米饭！你呢？ | no match | 0.14 |

Cost: ~1 ms, offline, no model. Requires `pypinyin` + `pykakasi` in the ear's venv (both already
installed, ~20 MB total).

## Proposed design (tomorrow)

1. **The mod sends context.** Along with the WAV, POST her previous message (the mod already
   receives it via `chat-delta`, so it can keep the last assistant text). No new plumbing beyond
   one field.
2. **The ear repairs before the brain sees it.** If the transcript contains a Latin token that is
   not in a small English wordlist, run `phonetic_repair` against the context. On a confident
   match, replace the token with `chinese/phrase (romaji)` in the transcript.
3. **Never guess silently.** Log `original -> repaired (score)` every time, and if nothing clears
   the threshold leave the transcript untouched — she already asks for a repeat, which is the
   correct behaviour for a genuine unknown.
4. **Measure with his own audio** before/after, like tonight: capture `lastWav`, replay through
   the ear with and without repair, and require the repair to win on his real cases without
   breaking the control.

## Prior art: has someone already solved this? (checked the web, 2026-11-22)

Yes for **Mandarin↔English**, no for **Japanese↔English**, and nobody solves the *quote* case.

**MediaTek Breeze-ASR-25 — the closest existing solution.** A Whisper-large-v2 fine-tune described as
adopting "an unified mix embedding for decoding, optimized for Mandarin-English code-switching
scenarios, **including intra-sentential switching**" — precisely the failure we hit. Open weights, a
paper (arXiv 2506.11130, model called "Twister"), benchmarks against Whisper-large-v2/v3 auto-detect,
and **GGUF conversions exist** (`tryambientai/Breeze-ASR-25-gguf`, `epapanita/...`, `lipik/...`), so it
can be dropped into whisper.cpp locally. It is optimised for *Taiwanese* Mandarin, which is a caveat
for our use but the same language pair.

**Qwen3-ASR (0.6B / 1.7B)** — 52 languages including zh/ja/en, language identification, streaming,
very fast. But the honest published state: Amical's comparison says on **Japanese mixed with English
"we found no published test at all"**. No claim to rely on.

**Per-token LID services** (Soniox, Gladia) — the vendor-correct answer: they decide language per
token rather than per utterance, which is exactly what our failure needs. Paid, cloud, and his voice
leaves the machine.

**Japanese↔English code-switching, open source: research only.** MERL's end-to-end language-tracking
recogniser (2018), the SwitchLingua multilingual code-switch dataset (NeurIPS 2025), and an ANLP 2024
paper on heterogeneous English/Japanese transcription. No drop-in weights, no local model.

**Community consensus** (Reddit r/LocalLLaMA threads, Amical's write-up): Whisper "drops half of any
sentence" when languages switch; the practical advice is set the language explicitly, use
`faster-whisper`'s per-segment re-detection for long audio, don't translate, and otherwise "use a
model built for it". Nobody reports a trick that makes Whisper handle a single quoted foreign word.

### What that changes in our plan

- The **quote case stays ours to solve.** Even a perfect code-switch model transcribes the sound he
  actually made — if he says "nina" for 你呢, any ASR returns "nina". Resolving it back to the phrase
  is a separate step, and `phonetic_repair.py` is that step.
- **Breeze-ASR-25 is a real upgrade path for Sasha** (Mandarin), not for Kana (Japanese). Worth a
  measured trial later: same test set, WER against SenseVoice, plus VRAM and latency.
- For Japanese there is nothing off the shelf, which is another reason the deterministic repair
  (which needs no model at all) is the right first move.

## Options considered and not chosen


- **Switch the ear to a code-switching ASR service** (per-token LID, e.g. Soniox). Architecturally
  the correct answer; costs per minute, adds network latency, sends his voice to a third party.
  Keep as the fallback if the repair proves too narrow.
- **Whisper `initial_prompt` biasing** with her last message. Cheap to try, but zero-shot biasing
  gains are modest and unpredictable on 1–4 syllable tokens; needs his audio to evaluate.
- **Hotword boosting in SenseVoice**: not supported (CTC, not transducer).
- **Asking him to say the word in isolation**: works, but destroys the fluency practice that is
  the entire point.

## Why this is the right shape for a learner specifically

A bilingual native switches mid-sentence between *languages*; a learner quotes a *phrase he just
heard*. That is a smaller, cleaner problem: the answer is in her last message, and the learner
always wants to know exactly that phrase. A "quote resolver" is enough for the learning use-case
even though it is not a general code-switch ASR.
