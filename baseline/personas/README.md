# Persona snapshot — 2026-11-22 (activation revision 61)

The persona the app actually runs lives in the **database**, not in
`characters/<id>/1.0.0/character.json` (that file is ignored at activation). This folder is the
committed copy so the build is reproducible.

Files: `kana.persona.txt` (6013 chars), `sasha.persona.txt` (4107 chars).

## Restore

```python
import sqlite3, pathlib, time
db = sqlite3.connect(r"C:/Users/USER/AppData/Roaming/com.chyin.kokoro/kokoro.db")
for cid in ("kana", "sasha"):
    text = pathlib.Path(f"baseline/personas/{cid}.persona.txt").read_text(encoding="utf-8")
    db.execute("update characters set persona=?, updated_at=? where id=?", (text, int(time.time()), cid))
db.commit()
```

`updated_at` must be an INTEGER epoch: writing a text timestamp makes every later activation fail
with a Rust type error. Then re-activate the character (`prepare_character_activation` +
`commit_character_activation`) so the prompt in `character_runtime_backend.json` is rebuilt.

## What these rules are for

The top `OUTPUT RULES` block is not style — it is what stopped her speaking gibberish: Japanese must be
written in kana/kanji (the voice reads Latin letters as English), romaji only in parentheses, never answer
a Japanese question in Chinese. The rest fixes the ear-vs-her confusion: never grade his pronunciation
from a Latin-letter transcript, and only correct a mistake she is sure of.
