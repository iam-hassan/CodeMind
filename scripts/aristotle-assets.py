#!/usr/bin/env python3
"""Turn the raw `Pet/` art into the sprite sheets the CodeMind panel loads.

Run once, and again only if the art in `Pet/` is replaced:

    python scripts/aristotle-assets.py

Reads   Pet/                            9 RGBA stills + 3 folders of green-screen JPEG frames
Writes  .../browser/media/aristotle/    4 PNG strips + a generated manifest.js

Why the art cannot be shipped as it is:

  * The animation frames are 1920x1080 green-screen JPEGs. JPEG has no alpha, so the pet
    would render as an opaque rectangle over the composer, and `.jpg` is not in the
    packaging glob (`media/**/*.{js,css,svg,png}`) — the frames would work in a dev build
    and then silently vanish from a release one.
  * Each animation moves through a different extent (stretch reaches left, butterfly flies
    up-right, sleep floats bubbles off the top). Cropping every frame to ONE shared rect is
    what stops the pet jumping when a state changes: one size, one anchor, no per-state
    offset maths in CSS.
  * The 9 direction stills are drawn at a different resolution than the animations
    (302x154 body vs 1164x596) and have to be scaled onto the same stage before they can
    stand in for an animation frame.
"""

from __future__ import annotations

import os
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover - tooling check, not logic
    sys.exit('This script needs Pillow and numpy: python -m pip install pillow numpy')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PET = os.path.join(ROOT, 'Pet')
OUT = os.path.join(
    ROOT, 'vscodium', 'src', 'stable', 'src', 'vs', 'workbench', 'contrib',
    'codemindAgent', 'browser', 'media', 'aristotle',
)

# The stills, in the order they are packed into idle.png. The sprite reads a direction
# name and needs a column index, so this list *is* the direction->column map.
DIRECTIONS = [
    ('center', 'axolotl.png'),
    ('top', 'axolotl_top.png'),
    ('top_right', 'axolotl_top_right.png'),
    ('right', 'axolotl_right.png'),
    ('bottom_right', 'axolotl_bottom_right.png'),
    ('bottom', 'axolotl_bottom.png'),
    ('bottom_left', 'axolotl_bottom_left.png'),
    ('left', 'axolotl_left.png'),
    ('top_left', 'axolotl_top_left.png'),
]

# Frame folders. Order matters only for the log.
ANIMS = [('stretch', 'axolotl_stretch'), ('butterfly', 'axolotl_butterfly'), ('sleep', 'axolotl_sleep')]

# Height of one output frame, in asset pixels. The panel displays the strip at half this,
# so the asset is 2x and stays crisp on a HiDPI screen.
OUT_H = 124

# Breathing room around the measured content, in stage (1920x1080) pixels, so a stray
# anti-aliased pixel at the edge of a frame is never clipped.
MARGIN = 8

# Frames per second for every animation. The source GIFs carried no timing metadata
# (the frames were extracted with ezgif, which drops it), so this is chosen: 12fps makes
# a 40-frame cycle 3.3s, which reads as unhurried without looking like a slideshow.
FPS = 12

# Alpha at or below this in a source still is noise from however the art was exported —
# a faint halo spread across the whole 500x500 canvas — not something anyone drew.
STILL_ALPHA_FLOOR = 24

def key_green(path: str) -> np.ndarray:
    """Load one green-screen frame as RGBA with the background removed.

    The test is green *dominance*, not distance from the measured key colour
    (47,172,72). Nothing the artist drew is green-dominant — the body is purple, the
    outline black, the highlights white, the blush pink — so `g > r` and `g > b` by a
    margin catches the background and every JPEG-blurred pixel between it and the
    outline, while a distance test would need a tolerance so wide it started eating
    the art. The clamp afterwards kills the residual green tint in pixels that sit just
    inside the threshold, which is what a green fringe around the outline is made of.
    """
    rgb = np.array(Image.open(path).convert('RGB')).astype(np.int16)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    background = (g > r + 20) & (g > b + 20)
    out = np.zeros(rgb.shape[:2] + (4,), dtype=np.uint8)
    keep = ~background
    # Clamp green to just above the other channels so a half-keyed pixel reads as a
    # dark outline pixel rather than a green one.
    g_clamped = np.minimum(g, np.maximum(r, b) + 12)
    out[:, :, 0] = r
    out[:, :, 1] = np.where(keep, g_clamped, 0)
    out[:, :, 2] = b
    out[:, :, 3] = np.where(keep, 255, 0)
    return out


def content_bbox(rgba: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1) of everything that is not fully transparent."""
    ys, xs = np.where(rgba[:, :, 3] > 0)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def solid_bbox(im: Image.Image, thr: int = 128) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of the pixels solid enough to be the drawing itself."""
    a = np.array(im.convert('RGBA'))[:, :, 3]
    ys, xs = np.where(a > thr)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def frame_paths(folder: str) -> list[str]:
    d = os.path.join(PET, folder)
    names = sorted(n for n in os.listdir(d) if n.lower().endswith('.jpg'))
    return [os.path.join(d, n) for n in names]


def load_still_onto_stage(path: str, scale: float, offset: tuple[int, int], stage: tuple[int, int]) -> Image.Image:
    """Scale one direction still so its body lands exactly where the animations' idle
    pose sits, on a transparent stage the size of an animation frame.

    Without this the eye-direction stills would be a different size than the frames they
    stand between, and every transition into or out of an animation would pop.
    """
    im = Image.open(path).convert('RGBA')
    a = np.array(im)
    a[:, :, 3] = np.where(a[:, :, 3] <= STILL_ALPHA_FLOOR, 0, a[:, :, 3])
    im = Image.fromarray(a)
    scaled = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    canvas = Image.new('RGBA', stage, (0, 0, 0, 0))
    # paste (not alpha_composite) because the offset is routinely negative: the still's
    # canvas is larger than the stage once scaled, and the part that falls outside is the
    # faint halo we do not want anyway.
    canvas.paste(scaled, offset, scaled)
    return canvas


def main() -> int:
    if not os.path.isdir(PET):
        sys.exit(f'No art at {PET}')
    os.makedirs(OUT, exist_ok=True)

    anim_frames = {name: frame_paths(folder) for name, folder in ANIMS}
    for name, paths in anim_frames.items():
        if not paths:
            sys.exit(f'No .jpg frames for {name}')
    stage = Image.open(anim_frames['sleep'][0]).size  # (1920, 1080)

    # ---- pass 1: measure -------------------------------------------------------------
    # The idle pose is the reference every state is aligned to. It is the first frame of
    # any sequence — all three animations open on the identical standing pose, which is
    # also what lets every state end back on idle without a bridging frame.
    idle_ref = content_bbox(key_green(anim_frames['sleep'][0]))
    assert idle_ref, 'first sleep frame is entirely background'
    iw, ih = idle_ref[2] - idle_ref[0], idle_ref[3] - idle_ref[1]

    still_box = solid_bbox(Image.open(os.path.join(PET, DIRECTIONS[0][1])))
    sw, sh = still_box[2] - still_box[0], still_box[3] - still_box[1]
    # One uniform scale, averaged over both axes. The two ratios agree to 0.4% (the still
    # art and the animation art are the same character at the same proportions), so a
    # non-uniform scale would buy nothing and would distort the pixels.
    scale = ((iw / sw) + (ih / sh)) / 2
    offset = (round(idle_ref[0] - still_box[0] * scale), round(idle_ref[1] - still_box[1] * scale))
    print(f'idle pose {idle_ref} ({iw}x{ih})  still body {still_box} ({sw}x{sh})')
    print(f'still scale {scale:.4f}  offset {offset}')

    union = list(idle_ref)

    def widen(bb: tuple[int, int, int, int] | None) -> None:
        if not bb:
            return
        union[0] = min(union[0], bb[0])
        union[1] = min(union[1], bb[1])
        union[2] = max(union[2], bb[2])
        union[3] = max(union[3], bb[3])

    for name, paths in anim_frames.items():
        for p in paths:
            widen(content_bbox(key_green(p)))
        print(f'measured {name}: {len(paths)} frames  union now {tuple(union)}')

    for _, fname in DIRECTIONS:
        st = load_still_onto_stage(os.path.join(PET, fname), scale, offset, stage)
        widen(content_bbox(np.array(st)))
    print(f'measured 9 stills   union now {tuple(union)}')

    crop = (
        max(0, union[0] - MARGIN), max(0, union[1] - MARGIN),
        min(stage[0], union[2] + MARGIN), min(stage[1], union[3] + MARGIN),
    )
    crop_w, crop_h = crop[2] - crop[0], crop[3] - crop[1]
    out_scale = OUT_H / crop_h
    frame_w = round(crop_w * out_scale)
    print(f'shared crop {crop} ({crop_w}x{crop_h}) -> frame {frame_w}x{OUT_H} (scale {out_scale:.4f})')

    # ---- pass 2: cut the strips ------------------------------------------------------
    def strip(images: list[Image.Image], path: str) -> None:
        sheet = Image.new('RGBA', (frame_w * len(images), OUT_H), (0, 0, 0, 0))
        for i, im in enumerate(images):
            cut = im.crop(crop).resize((frame_w, OUT_H), Image.LANCZOS)
            sheet.paste(cut, (i * frame_w, 0), cut)
        sheet.save(path, optimize=True)
        kb = os.path.getsize(path) / 1024
        print(f'  {os.path.basename(path)}: {len(images)} frames, {sheet.width}x{sheet.height}, {kb:.0f} KB')

    print('writing strips')
    strip([load_still_onto_stage(os.path.join(PET, f), scale, offset, stage) for _, f in DIRECTIONS],
          os.path.join(OUT, 'idle.png'))
    counts = {}
    for name, paths in anim_frames.items():
        # sleep's last frame is byte-identical to its first (the GIF's wrap frame); keeping
        # it would show the standing pose twice at the end of the wake-up.
        keep = paths[:-1] if name == 'sleep' else paths
        counts[name] = len(keep)
        strip([Image.fromarray(key_green(p)) for p in keep], os.path.join(OUT, f'{name}.png'))

    # Where the idle pose sits inside a frame, in display pixels. The frame is wider than
    # the pet because it has to hold the butterfly's flight and the sleep bubbles, so the
    # panel needs this to anchor the *pet* against the composer's edge rather than the
    # frame's — otherwise the empty right margin would push him inward.
    ds = out_scale / 2
    body = (
        round((idle_ref[0] - crop[0]) * ds), round((idle_ref[1] - crop[1]) * ds),
        round(iw * ds), round(ih * ds),
    )
    print(f'idle pose inside frame (display px): x={body[0]} y={body[1]} w={body[2]} h={body[3]}')
    write_manifest(frame_w, counts, body)
    print(f'\ndone — {OUT}')
    return 0


def write_manifest(frame_w: int, counts: dict[str, int], body: tuple[int, int, int, int]) -> None:
    """Emit the generated manifest the panel reads.

    A `.js` file assigning a global rather than a `.json` file, for two reasons: it is
    loaded with the same `<script src>` the panel already uses for its other media
    scripts, and the sprite therefore never has to `fetch()` — no async gap between the
    panel opening and the pet existing, and nothing to go wrong if a future build adds a
    Content-Security-Policy.
    """
    # Sleep is the one state that does not simply play and finish: it lies down, holds for
    # as long as nobody touches the panel, then gets up. These are source frame numbers
    # (1-based, as the files are named) and are the only place the segmentation lives.
    #
    #   001-005  standing idle
    #   006-011  crouching down
    #   012-028  lying asleep, Zzz bubbles rising  <- the body is static here, only the
    #                                                bubbles move, which is what makes it
    #                                                loopable
    #   029-030  lying asleep, bubbles gone
    #   031-040  getting back up
    #   (041)    standing idle again — dropped, it is a duplicate of 001
    sleep_intro = (1, 28)
    sleep_loop = (12, 28)
    sleep_outro = (29, 40)

    def span(pair: tuple[int, int]) -> str:
        return f'[{pair[0] - 1}, {pair[1] - 1}]'

    directions = ', '.join(f"{name}: {i}" for i, (name, _) in enumerate(DIRECTIONS))
    body = f'''/*---------------------------------------------------------------------------------------------
 *  GENERATED FILE — do not edit by hand.
 *  Written by scripts/aristotle-assets.py from the art in Pet/. Re-run that script
 *  after replacing the art; every number below is measured from it.
 *--------------------------------------------------------------------------------------------*/

// Frame geometry, state frame counts and the sleep segmentation for the composer pet.
// Read by media/aristotle.js. All frames in every strip share one size and one anchor,
// so a state change never moves the pet.
window.CodeMindAristotleFrames = {{
	/* One frame of any strip, in asset pixels. The strips are authored at 2x and shown at
	   half size, so the pet stays crisp on a HiDPI display. */
	frameWidth: {frame_w},
	frameHeight: {OUT_H},
	/* What the panel actually reserves, in CSS pixels. */
	displayWidth: {frame_w // 2},
	displayHeight: {OUT_H // 2},
	fps: {FPS},
	/* Where the standing pet sits inside a frame, in display pixels. Every frame is the
	   same size and holds the same stage, so this rect is true for every state — it is what
	   the panel anchors against so the pet, not the frame's empty margin, meets the
	   composer edge. */
	body: {{ x: {body[0]}, y: {body[1]}, width: {body[2]}, height: {body[3]} }},
	/* Which column of idle.png is which gaze direction. */
	directions: {{ {directions} }},
	/* Frame counts per strip. */
	counts: {{ idle: {len(DIRECTIONS)}, stretch: {counts['stretch']}, butterfly: {counts['butterfly']}, sleep: {counts['sleep']} }},
	/* Inclusive, 0-based frame ranges within sleep.png. */
	sleep: {{ intro: {span(sleep_intro)}, loop: {span(sleep_loop)}, outro: {span(sleep_outro)} }},
}};
'''
    path = os.path.join(OUT, 'manifest.js')
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(body)
    print(f'  manifest.js: frame {frame_w}x{OUT_H}, display {frame_w // 2}x{OUT_H // 2}, {FPS}fps')


if __name__ == '__main__':
    raise SystemExit(main())
