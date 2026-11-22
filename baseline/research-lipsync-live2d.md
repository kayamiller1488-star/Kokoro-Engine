# Research: lip sync + Live2D model setup (for Kokoro-Engine)

Prepared 2026-11-22 night for work on 2026-11-23. Nothing changed in the running build.

## Headline: lip sync already exists in this app, and it is already wired

`src/features/live2d/LipSyncProcessor.ts` (118 lines) turns audio analysis into two parameters, and
`Live2DController.ts` drives them every frame:

```
audio-player.ts  (Web Audio AnalyserNode, has addAmplitudeListener)
        └─> Live2DController.amplitudeHandler          (line 51)
              ├─> LipSyncProcessor.updateAudio(amplitude, lowFreq, highFreq)
              └─> speaking state: amplitude > 0.1 -> Speaking, <= 0.01 -> Idle
        └─> every tick: setParameterValueById("ParamMouthOpenY", mouth.mouthOpenY)
                        setParameterValueById("ParamMouthForm",   mouth.mouthForm)
```

Current tuning (`DEFAULT_CONFIG`): `gain 2.0`, `smoothing 0.25`, `threshold 0.01`,
`microMovement 0.05`. Mouth form is *inferred from the frequency balance* (low = rounder,
high = wider) — an approximation, not a viseme.

So "add lip sync" is not the task. The tasks are **verify, de-conflict, and improve quality.**

### Three concrete findings to act on

1. **There may be two drivers fighting.** `Live2DViewer.tsx:212-214` carries the comment
   *"This might conflict with the LipSyncProcessor in the controller"* immediately above
   `ctrl?.getLipSync().updateAudio(val); // Hacky adapter`. Two callers feeding one processor means
   amplitude is updated twice per frame with different sources. Measure first: log both drivers for
   one sentence and see whether the second path is live.
2. **No runtime tuning.** The config is hard-coded at construction; nothing in settings or
   `app-settings.ts` exposes gain/threshold. Cheap win: expose them like `__vaVoice.guardMs` so the
   mouth can be tuned without a rebuild.
3. **Amplitude-only lipsync has a known ceiling.** It cannot tell "m" from "a", and with a
   smoothed/gated signal the mouth tends to stay slightly open between syllables (which is what
   `microMovement` is papering over). The industry baseline (VTube Studio, Live2D SDK's own lip-sync
   manual) is exactly this amplitude method — it is acceptable, not good.

## Options for better lip sync, cheapest first

| option | what it gives | cost | risk |
|---|---|---|---|
| **A. Measure + tune** (gain, threshold, smoothing, drop the duplicate driver) | removes flap/floatiness; honest baseline number | hours, free | none |
| **B. Viseme from our own TTS text** | real mouth shapes (a/i/u/e/o/m) synced to phonemes | 1-2 days, free | needs timing per phoneme |
| **C. Offline viseme tools** (zh-lipsync for Mandarin, Rhubarb for A/B–H shapes) | good shapes from an audio file | free, but file-in/file-out latency | wrong shape for a live stream |
| **D. Cubism "motion-sync"** (pre-authored mouth track in the editor) | perfect for recorded lines | Cubism work per line | useless for generated speech |

**Option B is the interesting one, and it is only possible because we own the mouth.** Our TTS is
given the text, so we already know the phonemes: pinyin for Chinese (we just installed `pypinyin`),
kana for Japanese. Each syllable maps to a fixed mouth shape; the mouth can be driven from a
phoneme timeline instead of an amplitude envelope. No ASR, no new model, no cloud. The open question
is per-phoneme timing — Kokoro does not return alignments, so durations would come from syllable
count and the known total audio length (good enough for 2D, since LipSyncProcessor already smooths).

## Live2D model setup: mostly solved already, in our own notes

We have three skills covering this, so this section is a pointer plus the app-specific gaps:

- **`live2d-autorig`** — image → See-Through layer decomposition → PSD → PSD2Live auto-rig → `.moc3`,
  no Cubism Editor. Measured end-to-end on this machine (288 s of GPU). Tools already downloaded
  (`tools/PSD2Live/PSD2Live.exe`, See-Through models).
- **`live2d-model-sourcing`** — where to get a model and how to judge one in a minute. Free official
  samples (Hiyori, Mao, Haru, Mark, Rice, Wanko) are full rigs with physics + expressions, and Hiyori
  is what we are running now; nizima/itch.io/streamskins for others.
- **`live2d-parameter-driving`** — the rules for writing parameters from code (blend defaults to
  `Add`, expression overrides, one-sided data traps) — directly relevant to any lip-sync work.

### App-specific gaps to close tomorrow

1. **Where models live and how they are loaded.** `Live2DController` resolves a model path through
   `getLive2dModelProfile(modelPath)` (a Rust command) and maps it to an `asset://` URL
   (`live2d-model-url.ts`). No `.model3.json` was found under the app's roaming data, so the
   character models live inside the app folder — confirm the exact folder and the profile schema
   (which expressions, motions, physics and parameter list the app expects).
2. **Required parameters.** Confirm the profile declares `ParamMouthOpenY`, `ParamMouthForm`,
   `ParamEyeLOpen/ROpen`, `ParamAngleX/Y/Z`, `ParamBodyAngleX` — a model missing any of these will
   load but refuse to animate that part (this is the classic "model loads, face is dead" fault).
3. **Swap procedure.** What it takes to point the app at a different model (config field, character
   folder, DB row?) — this is the thing to document once, so the next model is a 10-minute job.

## Recommended order of work

1. Instrument the mouth: log both lip-sync drivers + final `mouthOpenY` for one spoken sentence.
   This answers "is it actually synced to her voice" with a number instead of an impression.
2. Remove the duplicate driver if it is live; expose gain/threshold as runtime knobs; tune by ear.
3. Prototype Option B (pinyin/kana → viseme timeline) behind a flag, compare side by side with the
   amplitude version on the same sentence.
4. Document the model-swap procedure, verified by actually swapping in a second model (Mao from the
   official samples is the cheapest test).
