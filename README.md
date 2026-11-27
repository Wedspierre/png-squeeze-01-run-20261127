# png-squeeze-01

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Wedspierre/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Wedspierre/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for the make.fun bounty **"Squeeze screenshots into the smallest PNG, 27 November 2026"** (`png-squeeze-01-run-20261127`). It takes eight 1280x720 RGBA screenshots and rewrites each one as the smallest valid PNG it can find — every pixel decodes back exactly, byte for byte.

## How it works

For each image, the program screens the ways the image can be written — palette, grey, grey+alpha, RGB, RGBA, with the transparent-value trick where it applies — and the per-row filter choices for each form, ranked by how small zlib compresses the filtered bytes. The two best candidates are then encoded three different ways and the smallest result wins:

- **zlib level 9** — Node's built-in compressor, the fast baseline.
- **Lazy optimal parsing** — a from-scratch DEFLATE encoder that walks the data with a hash-chain match search, picks each match or literal by its true bit cost, and rebuilds the Huffman tables from the first pass.
- **Full dynamic programming** — the same match search, but every position is scored with the exact bit cost of its Huffman-coded output, so the parse is optimal for the data in hand.

A small-file gate keeps the slow encoders off images where they cannot pay for themselves, and the program never fails a run: if an image cannot be encoded, the input is written back unchanged instead.

The PNG codec and the screening forms come from the competition kit itself (make.fun's own MIT code — see NOTICE). The DEFLATE encoders are original work written for this entry.

## Run it

Node 22, standard library only, no dependencies.

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

It reads `/input/<id>/image.png` for each `i001`–`i008` and writes `/output/<id>/image.png`. The whole set takes about 32 seconds of CPU on one core (the grader's wall budget is 60 seconds), and running it twice on the same inputs produces byte-identical outputs.

## Verification (practice set, 8 images)

| check | result |
|---|---|
| pixel-exact decode vs inputs (kit's own scorer) | 8/8 exact |
| score (kit scorer) | **714,832** — house baseline fixed-paeth 1.0.0 is 420,399 |
| determinism (two full runs) | byte-identical, all 8 images |
| edge cases (1x1, 3x2, single colour, fully transparent, 4-colour palette, random noise, grey gradient) | 8/8 pixel-exact, no crash |
| total output | 549,892 bytes (from 29,499,744 bytes of stored input PNGs) |

---

<sub>Entered on [make.fun](https://make.fun/?ref=ta01qs0h&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
