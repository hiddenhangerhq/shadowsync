# Generates simple PWA icons (dark tile, teal ring + "S"). Run: python3 scripts/make-icons.py
from PIL import Image, ImageDraw, ImageFont
import glob

def font(sz):
    for p in glob.glob("/usr/share/fonts/**/*Bold*.ttf", recursive=True) + glob.glob("/usr/share/fonts/**/*.ttf", recursive=True):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

def icon(size, maskable=False):
    s = size * 4
    im = Image.new("RGB", (s, s), (10, 15, 18))
    d = ImageDraw.Draw(im)
    pad = int(s * (0.22 if maskable else 0.12))
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=int(s * 0.18), outline=(34, 211, 176), width=int(s * 0.03), fill=(18, 27, 32))
    f = font(int(s * 0.5))
    bb = d.textbbox((0, 0), "S", font=f)
    d.text(((s - (bb[2] - bb[0])) / 2 - bb[0], (s - (bb[3] - bb[1])) / 2 - bb[1]), "S", font=f, fill=(34, 211, 176))
    gold = int(s * 0.05)  # tiny gold accent dot
    d.ellipse([s - pad - gold * 3, pad + gold, s - pad - gold, pad + gold * 3], fill=(214, 178, 94))
    return im.resize((size, size), Image.LANCZOS)

icon(192).save("public/icons/icon-192.png")
icon(512).save("public/icons/icon-512.png")
icon(512, True).save("public/icons/icon-maskable-512.png")
icon(180).save("public/icons/apple-touch-icon.png")
