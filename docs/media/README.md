# Demo assets

`muninn-demo.gif` is embedded at the top of [`../../README.md`](../../README.md). It is not a
mock-up: every command and every line of output is captured from the built CLI.

## Regenerating

```sh
npm run build
python3 docs/media/render_demo.py
```

The script needs [Pillow](https://python-pillow.org/) (`python3 -m pip install pillow`). It:

1. creates a throwaway project under a temporary directory (`README.md`, `ADR.md`, two TypeScript
   sources) and a throwaway `MUNINN_HOME`;
2. runs `muninn memory init`, `seed`, `index`, `end-session` and `memory brief` against it;
3. shortens the absolute paths to `~/acme-api` and `~/.muninn`, and normalises the project uid;
4. draws the captured text as a terminal (JetBrains Mono when installed, a fontconfig monospace
   fallback otherwise) and writes the GIF. The only presentation change is the success mark:
   JetBrains Mono's U+2714 reads like a box at this size, so it is drawn as U+2713.

`ImageMagick`'s `convert` is used afterwards when available to shrink the file; set
`MUNINN_DEMO_NO_OPTIMIZE=1` to keep the raw frames. The recording takes about two minutes because
every frame is rendered at 2× and downsampled for smooth text.

## Editing the story

Scenes live in `record()` in `render_demo.py`: the session chip, the typed command lines and the
captured output. Output is never retyped by hand, so changing a CLI message and re-running the
script keeps the demo honest. If a command starts printing more lines than the 32-line viewport,
trim `brief_lines[:32]` in the last scene.
