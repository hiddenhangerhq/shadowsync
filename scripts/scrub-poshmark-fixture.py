# Builds tests/fixtures/poshmark/edit-real.html from a saved Poshmark Edit Listing page: keeps only the form controls we drive.
import re, sys
from bs4 import BeautifulSoup, Comment
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
soup = BeautifulSoup(raw, "lxml")
for t in soup(["script", "style", "noscript", "svg", "img", "iframe", "link", "meta", "picture", "video"]): t.decompose()
for c in soup.find_all(string=lambda s: isinstance(s, Comment)): c.extract()
def sec(name):
    el = soup.find(attrs={"data-et-name": name}); assert el, name; return el
title = soup.find("input", attrs={"data-vv-name": "title"}).find_parent(attrs={"data-et-name": "listingEditorTitle"})
desc = soup.find("textarea", attrs={"data-vv-name": "description"})
qty = sec("listingEditorQuanititySection")
pricing = sec("listingEditorPricingSection")
avail = sec("listingEditorAvailabilitySection")
actions = soup.find(attrs={"data-et-name": "update"}).find_parent(class_="form__actions")
# The modals we care about (delete confirm, "Problem Detected", availability error), still closed as saved.
def modal_with(text):
    for m in soup.find_all(attrs={"data-test": "modal-container"}):
        if text in m.get_text(" "): return m.parent
modals = [modal_with(t) for t in ["want to delete this item", "Problem Detected", "Unable to mark listing"]]
parts = [title, desc.parent if desc.parent.name != "body" else desc, qty, pricing, avail, actions] + [m for m in modals if m]
# drop the price-suggestion modal (other people's listings) and every other modal inside the kept sections
for p in parts[:6]:
    for m in p.find_all(attrs={"data-test": "modal-container"}):
        if not m.find(id="listing-price-modal-listing-price-input"): m.parent.decompose()
        else:
            for x in m.find_all(class_=re.compile("shipping-discount|similar-sold|range-price")): x.decompose()
    for a in p.find_all(attrs={"data-test": "carousel"}): a.decompose()
html = "\n".join(str(p) for p in parts)
s = BeautifulSoup(html, "lxml")
for el in s.find_all(True):
    for k in list(el.attrs):
        if k.startswith("data-et-prop") or k in ("href", "src", "srcset", "style") and not (k == "style" and "display: none" in str(el.attrs[k])) or k.startswith("data-v-") or k in ("value",) and el.name != "option":
            del el.attrs[k]
    if el.name == "a" and el.attrs.get("class") and "btn" in el.attrs["class"]: el.attrs["href"] = "https://poshmark.com/listing/x-a1b2c3d4e5f6a1b2c3d4e5f6"
out = str(s.body.decode_contents() if s.body else s)
out = re.sub(r"[a-f0-9]{24}", "a1b2c3d4e5f6a1b2c3d4e5f6", out)
out = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "00000000-0000-0000-0000-000000000000", out)
out = re.sub(r">\s+<", "><", out)
hdr = "<!-- Scrubbed from a real Poshmark Edit Listing page (saved Oct 2026): form markup only; no scripts, state, ids or personal data. Field values are set by the tests. -->\n"
open(sys.argv[2], "w").write(hdr + "<main>" + out + "</main>\n")
print(len(out))
