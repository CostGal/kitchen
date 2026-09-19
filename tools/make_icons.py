"""Generates the PWA icons. Run: python tools/make_icons.py  (needs Pillow).
Opaque RGB, not pre-rounded — iOS/Android apply their own mask."""
from PIL import Image, ImageDraw
ACC = (217, 119, 87)

def icon(size, scale=1.0):
    S = size * 4
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    c = S / 2
    u = S * 0.30 * scale          # one "radius" of the mark
    w = max(1, int(S * 0.055 * scale))
    ly = c - u * 0.46             # the lid
    d.line([c - u * 1.04, ly, c + u * 1.04, ly], fill=ACC, width=w)
    k = u * 0.15                  # the knob on the lid
    d.ellipse([c - k, ly - u * 0.42 - k, c + k, ly - u * 0.42 + k], fill=ACC)
    d.line([c, ly, c, ly - u * 0.40], fill=ACC, width=w)
    d.rounded_rectangle(          # the pot, tucked just under the lid
        [c - u * 0.86, c - u * 0.34, c + u * 0.86, c + u * 0.92],
        radius=u * 0.34, outline=ACC, width=w)
    return im.resize((size, size), Image.LANCZOS)

icon(180).save('icon-180.png')
icon(192).save('icon-192.png')
icon(512).save('icon-512.png')
icon(512, 0.78).save('icon-512-maskable.png')
