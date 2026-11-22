#!/usr/bin/env python3
"""Renders docs/media/muninn-demo.gif from real CLI output.

It creates a throwaway project, runs the built CLI against a throwaway
MUNINN_HOME, shortens the absolute paths and draws the captured text as a
terminal, so the GIF never drifts from real output. Re-run after changing
user-facing CLI output:

    npm run build
    python3 docs/media/render_demo.py

Requires Pillow (``python3 -m pip install pillow``). ImageMagick's ``convert``
is used afterwards when available to shave bytes from the GIF.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

MEDIA_DIR = Path(__file__).resolve().parent
REPO_ROOT = MEDIA_DIR.parents[1]
CLI = REPO_ROOT / "dist" / "cli.js"
OUTPUT = MEDIA_DIR / "muninn-demo.gif"

SCALE = 2
WIDTH = 1120
HEIGHT = 784
INSET = 14
LINE_HEIGHT = 20
FONT_SIZE = 15

BG = (13, 17, 23)
WINDOW_BG = (13, 17, 23)
BORDER = (48, 54, 61)
TITLE = (139, 148, 158)
SEP = (33, 38, 45)
TEXT = (201, 209, 217)
WHITE = (230, 237, 243)
GREEN = (126, 231, 135)
CYAN = (121, 192, 255)
BLUE = (88, 166, 255)
DIM = (110, 118, 129)

FONT_CANDIDATES = {
    "regular": [
        "JetBrainsMonoNerdFont-Regular.ttf",
        "/home/*/.local/share/fonts/JetBrainsMonoNerdFont-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ],
    "semibold": [
        "/home/*/.local/share/fonts/JetBrainsMonoNerdFont-SemiBold.ttf",
        "JetBrainsMonoNerdFont-SemiBold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    ],
}


def find_font(kind: str) -> str:
    import glob

    for candidate in FONT_CANDIDATES[kind]:
        matches = glob.glob(candidate) if "*" in candidate else [candidate]
        for path in matches:
            if os.path.exists(path):
                return path
    # Last resort: whatever fontconfig exposes as monospace.
    try:
        out = subprocess.run(
            ["fc-match", "-f", "%{file}", "monospace:bold" if kind == "semibold" else "monospace"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if out and os.path.exists(out):
            return out
    except Exception:
        pass
    raise SystemExit("No monospace font found; install JetBrains Mono or DejaVu Sans Mono.")


FONT = ImageFont.truetype(find_font("regular"), FONT_SIZE * SCALE)
FONT_BOLD = ImageFont.truetype(find_font("semibold"), FONT_SIZE * SCALE)
FONT_SMALL = ImageFont.truetype(find_font("regular"), 12 * SCALE)
FONT_CHIP = ImageFont.truetype(find_font("semibold"), 12 * SCALE)
CHAR_W = FONT.getlength("M") / SCALE

CONTENT_X = 48
CONTENT_TOP = 86
def s(value: float) -> int:
    return int(round(value * SCALE))


# ---------------------------------------------------------------------------
# Recording: real project, real CLI
# ---------------------------------------------------------------------------

DEMO_FILES = {
    "README.md": """# acme-api

A small counter API used to try Muninn.

## Overview

The API keeps counters per namespace and exposes them over HTTP.

## Scripts

- build: `npm run build`
- test: `npm test`
""",
    "ADR.md": """# ADRs

## ADR-1: Counters live in SQLite

- **Date**: 2026-11-20
- **Status**: Accepted
- **Context**: In-memory counters vanish on restart and tests need persistence.
- **Decision**: Store counters in SQLite with WAL enabled, one table per namespace.
- **Consequences**: Restarts preserve counters; tests run against `:memory:`.
""",
    "src/counters.ts": """export interface Counter { name: string; value: number; }

export function increment(counter: Counter, by = 1): Counter {
  return { ...counter, value: counter.value + by };
}
""",
    "src/store.ts": """import { increment, type Counter } from "./counters.js";

const counters = new Map<string, Counter>();

export function bump(name: string): number {
  const current = counters.get(name) ?? { name, value: 0 };
  const next = increment(current);
  counters.set(name, next);
  return next.value;
}
""",
}


@dataclass
class Scene:
    chip: str
    chip_color: tuple[int, int, int]
    command_lines: list[str]
    output: list[str]
    trailing_prompt: bool


def run_cli(project: Path, home: Path, args: list[str]) -> str:
    env = {**os.environ, "MUNINN_HOME": str(home), "NO_COLOR": "1", "FORCE_COLOR": "0"}
    result = subprocess.run(
        ["node", str(CLI), *args],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.rstrip("\n")


def redact(text: str, project: Path, home: Path) -> str:
    text = text.replace(str(home), "~/.muninn")
    text = text.replace(str(project), "~/acme-api")
    # A long uid reads as noise at 15 px, and the line is illustrative anyway.
    text = re.sub(r"\bp-[0-9a-f]{20}\b", "p-063b9b28818b8a1ce645", text)
    return text


def record() -> list[Scene]:
    if not CLI.exists():
        raise SystemExit(f"{CLI} is missing; run `npm run build` first.")
    node = shutil.which("node")
    if not node:
        raise SystemExit("node is required to record the demo.")

    with tempfile.TemporaryDirectory(prefix="muninn-demo-") as tmp:
        root = Path(tmp)
        project = root / "acme-api"
        home = root / "home"
        for rel, content in DEMO_FILES.items():
            target = project / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        home.mkdir()

        init = run_cli(project, home, ["memory", "init", "--project", "."])
        seed = run_cli(project, home, ["seed", "--project", "."])
        index = run_cli(project, home, ["index", "--project", "."])
        handoff = run_cli(
            project,
            home,
            [
                "end-session",
                "--goal",
                "Counters on SQLite",
                "--state",
                "WAL enabled; migration pending",
                "--next",
                "write migration;add tests",
            ],
        )
        brief = run_cli(project, home, ["memory", "brief", "--project", "."])

        clips = [redact(text, project, home).splitlines() for text in (init, seed, index, handoff, brief)]

    init_lines, seed_lines, index_lines, handoff_lines, brief_lines = clips

    setup_output = init_lines + [""] + seed_lines + [""] + index_lines
    return [
        Scene(
            chip="SETUP · once",
            chip_color=DIM,
            command_lines=["muninn memory init && muninn seed && muninn index"],
            output=setup_output,
            trailing_prompt=True,
        ),
        Scene(
            chip="SESSION 1 · Claude Code",
            chip_color=BLUE,
            command_lines=[
                'muninn end-session --goal "Counters on SQLite" \\',
                '  --state "WAL enabled; migration pending" \\',
                '  --next "write migration;add tests"',
            ],
            output=handoff_lines,
            trailing_prompt=True,
        ),
        Scene(
            chip="SESSION 2 · Cursor",
            chip_color=(188, 140, 255),
            command_lines=["muninn memory brief"],
            # The viewport holds the first 32 lines; the handoff and the decision
            # are what the scene is for, and a real terminal would clip here too.
            output=brief_lines[:32],
            trailing_prompt=False,
        ),
    ]


# ---------------------------------------------------------------------------
# Terminal renderer
# ---------------------------------------------------------------------------


def line_style(text: str) -> tuple[tuple[int, int, int], bool]:
    stripped = text.strip()
    if stripped.startswith("✔") or stripped.startswith("✓"):
        return GREEN, False
    if text.startswith("# "):
        return CYAN, True
    if text.startswith("## "):
        return CYAN, True
    if text.startswith("### "):
        return CYAN, False
    if stripped.startswith("A new session"):
        return DIM, False
    return TEXT, False


def draw_centered_pill(
    image: Image.Image,
    draw: ImageDraw.ImageDraw,
    right: int,
    cy: int,
    text: str,
    color: tuple[int, int, int],
) -> None:
    tw = FONT_CHIP.getlength(text) / SCALE
    pad_x = 10
    height = 22
    left = right - tw - pad_x * 2
    top = cy - height / 2
    rgba = Image.new("RGBA", (WIDTH * SCALE, HEIGHT * SCALE), (0, 0, 0, 0))
    pill = ImageDraw.Draw(rgba)
    tint = tuple(min(255, int(c * 0.18) + 12) for c in color)
    pill.rounded_rectangle(
        [s(left), s(top), s(right), s(top + height)],
        radius=s(11),
        fill=(*tint, 255),
    )
    image.paste(rgba, (0, 0), rgba)
    draw.text((s(left + pad_x), s(top + 4)), text, font=FONT_CHIP, fill=color)


def render(lines: list[tuple[str, str]], chip: str, chip_color, cursor: tuple[int, int] | None) -> Image.Image:
    image = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), BG)
    draw = ImageDraw.Draw(image)

    # Window frame.
    draw.rounded_rectangle(
        [s(INSET), s(INSET), s(WIDTH - INSET), s(HEIGHT - INSET)],
        radius=s(12),
        fill=WINDOW_BG,
        outline=BORDER,
        width=max(1, s(1)),
    )

    # Traffic lights and title.
    for index, color in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx = INSET + 26 + index * 20
        draw.ellipse([s(cx - 5), s(36 - 5), s(cx + 5), s(36 + 5)], fill=color)
    draw.text((s(INSET + 84), s(28)), "muninn — acme-api", font=FONT_SMALL, fill=TITLE)
    draw_centered_pill(image, draw, WIDTH - INSET - 18, 36, chip, chip_color)
    draw.line([s(INSET + 1), s(62), s(WIDTH - INSET - 1), s(62)], fill=SEP)

    x0 = CONTENT_X
    y = CONTENT_TOP
    for row, (text, kind) in enumerate(lines):
        # JetBrains Mono draws U+2714 (heavy check) as a tall box that reads like
        # tofu at 15 px; U+2713 is the same success mark and stays legible.
        text = text.replace("\u2714", "\u2713")
        color, bold = line_style(text)
        if kind == "cmd":
            color = WHITE
        elif kind == "prompt":
            color = GREEN
        font = FONT_BOLD if bold else FONT
        if kind == "cmd":
            draw.text((s(x0), s(y)), "$ ", font=FONT_BOLD, fill=GREEN)
            draw.text((s(x0 + 2 * CHAR_W), s(y)), text, font=font, fill=color)
        elif kind == "cont":
            draw.text((s(x0), s(y)), text, font=font, fill=WHITE)
        else:
            draw.text((s(x0), s(y)), text, font=font, fill=color)
        if cursor and cursor[0] == row:
            cx = x0 + cursor[1] * CHAR_W
            draw.rectangle([s(cx), s(y + 2), s(cx + CHAR_W), s(y + FONT_SIZE + 3)], fill=(138, 180, 255))
        y += LINE_HEIGHT

    return image.resize((WIDTH, HEIGHT), Image.LANCZOS)


# ---------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------


@dataclass
class Frame:
    image: Image.Image
    duration: int


def build_frames(scenes: list[Scene]) -> list[Frame]:
    frames: list[Frame] = []
    lines: list[tuple[str, str]] = []
    typing_gap = 24  # ms per typed frame
    chunk = 2  # characters per frame
    output_gap = 70

    def shot(duration: int, cursor: tuple[int, int] | None = None) -> None:
        frames.append(Frame(render(lines, chip, chip_color, cursor), duration))

    for scene_index, scene in enumerate(scenes):
        chip = scene.chip
        chip_color = scene.chip_color
        lines = []
        if scene_index > 0:
            # A short beat of the previous frame keeps the cut readable.
            frames.append(Frame(frames[-1].image, 420))
        # Prompt.
        for line_index, entry in enumerate(scene.command_lines):
            row = len(lines)
            kind = "cmd" if line_index == 0 else "cont"
            lines.append((entry, kind))
            visible = ""
            offset = 2 if kind == "cmd" else 0
            for start in range(0, len(entry), chunk):
                visible = entry[: start + chunk]
                lines[row] = (visible, kind)
                shot(typing_gap, cursor=(row, len(visible) + offset))
            lines[row] = (entry, kind)
            if entry.endswith("\\"):
                # Continuation: show the completed line and add the next one.
                shot(30)
                continue
            shot(60)
        # Command is complete; emit the output line by line.
        for text in scene.output:
            lines.append((text, "out"))
            shot(output_gap)
        if scene.trailing_prompt:
            lines.append(("", "prompt"))
            # Idle cursor blinking so the frame does not feel frozen.
            for blink in range(6):
                shot(220, cursor=(len(lines) - 1, 2) if blink % 2 == 0 else None)
        else:
            # Hold the final view with a blinking cursor on the last line.
            row = len(lines) - 1
            for blink in range(8):
                shot(240, cursor=(row, len(lines[row][0])) if blink % 2 == 0 else None)
    return frames


def save_gif(frames: list[Frame]) -> None:
    # One global palette keeps colors stable between frames; the terminal has
    # few colors, so 192 entries are plenty.
    sample = Image.new("RGB", (WIDTH, HEIGHT * 4))
    for index, pick in enumerate([0, len(frames) // 3, (2 * len(frames)) // 3, len(frames) - 1]):
        sample.paste(frames[pick].image, (0, HEIGHT * index))
    palette_source = sample.quantize(colors=192, method=Image.MEDIANCUT)
    frames_p: list[Image.Image] = []
    durations: list[int] = []
    for frame in frames:
        frames_p.append(frame.image.quantize(palette=palette_source, dither=Image.Dither.NONE))
        durations.append(frame.duration)

    frames_p[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames_p[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )

    convert = None if os.environ.get("MUNINN_DEMO_NO_OPTIMIZE") else shutil.which("convert")
    if convert:
        tmp = OUTPUT.with_suffix(".opt.gif")
        subprocess.run(
            [convert, str(OUTPUT), "-layers", "Optimize", str(tmp)],
            check=True,
            capture_output=True,
        )
        if tmp.stat().st_size < OUTPUT.stat().st_size:
            tmp.replace(OUTPUT)
        else:
            tmp.unlink()

    size = OUTPUT.stat().st_size
    print(f"Wrote {OUTPUT} ({size / 1024:.0f} KiB, {len(frames_p)} frames)")
    if size > 5 * 1024 * 1024:
        print("warning: GIF is larger than 5 MiB; consider trimming hold frames.", file=sys.stderr)


def main() -> None:
    scenes = record()
    frames = build_frames(scenes)
    save_gif(frames)


if __name__ == "__main__":
    main()
