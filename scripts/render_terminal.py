#!/usr/bin/env python3
"""Render a real terminal recording (from `script`) into a PNG screenshot.

The input is the raw byte stream the CLI wrote to a pseudo-terminal, captured by
`script -qfec "<command>" file.typescript`. This replays it through a minimal
terminal model (carriage return, erase-line, SGR colours) so the PNG shows the
final screen exactly as a person would have seen it. Nothing is retyped.

Usage: python3 scripts/render_terminal.py in.typescript out.png ["$ command shown on top"]
"""
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BG = (24, 24, 27)
FG = (228, 228, 231)
PALETTE = {30: (60, 60, 60), 31: (248, 113, 113), 32: (74, 222, 128), 33: (250, 204, 21), 34: (96, 165, 250),
           35: (232, 121, 249), 36: (34, 211, 238), 37: (228, 228, 231), 90: (140, 140, 150), 91: (252, 165, 165),
           92: (134, 239, 172), 93: (253, 224, 71), 94: (147, 197, 253), 95: (240, 171, 252), 96: (103, 232, 249)}
TOKEN = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z])|(\r\n|\n|\r)|([^\x1b\r\n]+)")


def replay(text):
    lines = [[]]   # each line: list of (char, colour, bold, dim)
    col = 0
    colour, bold, dim = FG, False, False
    for match in TOKEN.finditer(text):
        params, final, newline, chars = match.groups()
        if final:
            if final == "m":
                codes = [int(c) for c in params.split(";") if c.isdigit()] or [0]
                for code in codes:
                    if code == 0:
                        colour, bold, dim = FG, False, False
                    elif code == 1:
                        bold = True
                    elif code == 2:
                        dim = True
                    elif code in PALETTE:
                        colour = PALETTE[code]
            elif final == "K":
                lines[-1] = lines[-1][:col] if params in ("", "0") else []
                if params == "2":
                    lines[-1] = []
            continue  # cursor show/hide etc. do not change the picture
        if newline:
            if newline == "\r":
                col = 0
            else:
                lines.append([])
                col = 0
            continue
        line = lines[-1]
        for ch in chars:
            cell = (ch, colour, bold, dim)
            if col < len(line):
                line[col] = cell
            else:
                line.append(cell)
            col += 1
    return lines


def main():
    source, target = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else None
    raw = open(source, "rb").read().decode("utf-8", "replace")
    # Drop the "Script started/done" bookkeeping lines added by `script`.
    raw = re.sub(r"^Script started.*?\n", "", raw)
    raw = re.sub(r"\n?Script done.*$", "", raw, flags=re.S)
    lines = replay(raw)
    while lines and not lines[-1]:
        lines.pop()
    if title:
        lines.insert(0, [(ch, PALETTE[90], False, False) for ch in title])
    font = ImageFont.truetype(FONT, 15)
    bold_font = ImageFont.truetype(FONT.replace("SansMono.ttf", "SansMono-Bold.ttf"), 15)
    cw = font.getbbox("M")[2]
    ch = 21
    width = max(80, max((len(line) for line in lines), default=0)) * cw + 40
    image = Image.new("RGB", (width, len(lines) * ch + 56), BG)
    draw = ImageDraw.Draw(image)
    for i, colour in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        draw.ellipse((14 + i * 20, 10, 26 + i * 20, 22), fill=colour)
    for row, line in enumerate(lines):
        for column, (char, colour, bold, dim) in enumerate(line):
            if dim:
                colour = tuple(int(c * 0.6 + b * 0.4) for c, b in zip(colour, BG))
            draw.text((20 + column * cw, 36 + row * ch), char, font=bold_font if bold else font, fill=colour)
    image.save(target)
    print(f"wrote {target} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
