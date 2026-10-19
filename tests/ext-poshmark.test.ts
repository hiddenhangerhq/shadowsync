// @vitest-environment happy-dom
// Poshmark step logic against small hand-written HTML fixtures (no live Poshmark from our servers, by rule).
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runStep } from "../extension/src/content/entry";
import { pageOf, parseSales, signedIn } from "../extension/src/content/poshmark";
import type { StepInput } from "../extension/src/steps";
import type { Action } from "../src/lib/ext/protocol";

const fx = (n: string) => readFileSync(`tests/fixtures/poshmark/${n}.html`, "utf8");
const load = (...parts: string[]) => { document.body.innerHTML = parts.map(fx).join("\n"); };
const ID = "a1b2c3d4e5f6a1b2c3d4e5f6";
const U = { home: "https://poshmark.com/feed", edit: `https://poshmark.com/edit-listing/${ID}`, listing: `https://poshmark.com/listing/x-${ID}`, login: "https://poshmark.com/login?next=/feed", sales: "https://poshmark.com/order/sales", create: "https://poshmark.com/create-listing", closet: "https://poshmark.com/closet/davidsells" };
const step = (action: Action, url: string, payload: Record<string, unknown> = {}, phase = "start") =>
  runStep(document, { action, marketplace: "poshmark", payload, phase, url } satisfies StepInput);
let clicked: string[] = [];
document.addEventListener("click", (e) => clicked.push(((e.target as HTMLElement).textContent ?? "").trim()));
beforeEach(() => { clicked = []; document.body.innerHTML = ""; });

describe("page and sign-in detection", () => {
  it("knows the pages by URL", () => {
    expect(pageOf(U.edit)).toBe("edit"); expect(pageOf(U.listing)).toBe("listing"); expect(pageOf(U.login)).toBe("login");
    expect(pageOf(U.sales)).toBe("sales"); expect(pageOf(U.home)).toBe("home"); expect(pageOf("https://poshmark.com/brand/x")).toBe("other");
  });
  it("checkLogin reads the header and says so; an unclear page answers 'unknown' (not an error)", () => {
    load("header-in"); expect(signedIn(document)).toBe(true); expect(step("checkLogin", U.home)).toEqual({ kind: "done", loggedIn: true });
    load("header-out"); expect(step("checkLogin", U.home)).toEqual({ kind: "done", loggedIn: false });
    expect(step("checkLogin", U.login)).toEqual({ kind: "done", loggedIn: false });
    document.body.innerHTML = "<main>hello</main>";
    expect(step("checkLogin", U.home)).toMatchObject({ kind: "done", loggedIn: null });
    document.body.innerHTML = '<header><button role="menuitem">Log Out</button></header>';
    expect(step("checkLogin", U.home)).toEqual({ kind: "done", loggedIn: true });
  });
  it("signed out or a login redirect stops a job with signed_out", () => {
    load("header-out", "edit-select");
    expect(step("delist", U.edit, { externalId: ID })).toMatchObject({ kind: "stop", code: "signed_out" });
    expect(step("delist", U.login, { externalId: ID })).toMatchObject({ kind: "stop", code: "signed_out" });
  });
  it("a captcha stops everything and keeps the tab for you; nothing is clicked", () => {
    load("header-in", "captcha");
    expect(step("delist", U.edit, { externalId: ID })).toMatchObject({ kind: "stop", code: "captcha", keepTab: true });
    expect(step("checkLogin", U.home)).toMatchObject({ kind: "stop", code: "captcha" });
    document.body.innerHTML = fx("header-in") + "<p>We noticed unusual activity. Enter the code we sent to your phone.</p>";
    expect(step("delist", U.edit, { externalId: ID })).toMatchObject({ kind: "stop", code: "challenge" });
    expect(clicked).toEqual([]);
  });
  it("a missing listing is listing_not_found", () => {
    load("header-in", "notfound");
    expect(step("delist", U.listing, { externalId: ID })).toMatchObject({ kind: "stop", code: "listing_not_found" });
  });
});

describe("delist / markSold: set Not For Sale (reversible, never delete)", () => {
  it("native select: picks Not For Sale, presses Update, then confirms on the listing page", () => {
    load("header-in", "edit-select");
    expect(step("markSold", U.edit, { externalId: ID })).toEqual({ kind: "wait", phase: "saved", ms: 5000 });
    expect((document.getElementById("avail") as HTMLSelectElement).value).toBe("not_for_sale");
    expect(clicked).toEqual(["Update"]);
    document.body.innerHTML = fx("header-in") + "<main><h1>Nike Polo</h1><span>Not For Sale</span></main>";
    expect(step("markSold", U.listing, { externalId: ID }, "saved")).toMatchObject({ kind: "done", result: { alreadyDone: false } });
  });
  it("already Not For Sale, or already sold: done, nothing clicked", () => {
    load("header-in", "edit-select");
    (document.getElementById("avail") as HTMLSelectElement).value = "not_for_sale";
    expect(step("delist", U.edit, { externalId: ID })).toMatchObject({ kind: "done", result: { alreadyDone: true } });
    document.body.innerHTML = fx("header-in") + "<main><h1>Nike Polo</h1><span class='sold-tag'>Sold</span></main>";
    expect(step("delist", U.listing, { externalId: ID })).toMatchObject({ kind: "done", result: { alreadyDone: true } });
    expect(clicked).toEqual([]);
  });
  it("custom dropdown: open it, then pick Not For Sale, then Update", () => {
    load("header-in", "edit-dropdown");
    const menu = document.querySelector("ul") as HTMLElement;
    document.querySelector('[role="button"]')!.addEventListener("click", () => { menu.hidden = false; });
    expect(step("delist", U.edit, { externalId: ID })).toEqual({ kind: "wait", phase: "pick", ms: 800 });
    expect(step("delist", U.edit, { externalId: ID }, "pick")).toEqual({ kind: "wait", phase: "saved", ms: 5000 });
    expect(clicked).toEqual(["For Sale", "Not For Sale", "Update"]);
  });
  it("stayed on the edit page after Update: shows the error, or stops for you", () => {
    load("header-in", "edit-select");
    expect(step("delist", U.edit, { externalId: ID }, "saved")).toEqual({ kind: "wait", phase: "saved2", ms: 5000 }); // give it a little longer
    expect(step("delist", U.edit, { externalId: ID }, "saved2")).toMatchObject({ kind: "stop", code: "unexpected_page", keepTab: true });
    document.body.insertAdjacentHTML("beforeend", "<div role='alert'>Price must be at least $3</div>");
    expect(step("delist", U.edit, { externalId: ID }, "saved")).toMatchObject({ kind: "stop", code: "rejected", message: expect.stringContaining("at least $3") });
  });
  it("an edit page without the Availability control stops (no guessing)", () => {
    document.body.innerHTML = fx("header-in") + "<main><h1>Edit Listing</h1><button>Update</button></main>";
    expect(step("delist", U.edit, { externalId: ID })).toMatchObject({ kind: "stop", code: "unexpected_page" });
    expect(clicked).toEqual([]);
  });
  it("a listing page that is still for sale goes to the edit page", () => {
    document.body.innerHTML = fx("header-in") + "<main><h1>Nike Polo</h1><button>Buy Now</button></main>";
    expect(step("delist", U.listing, { externalId: ID })).toEqual({ kind: "goto", page: "edit", phase: "start" });
  });
});

describe("delete after a confirmed sale, with a Not For Sale fallback", () => {
  const D = { externalId: ID, mode: "delete" };
  const openDialogOnDelete = () => {
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
    document.querySelector(".delete-listing")!.addEventListener("click", () => { dlg.hidden = false; });
    return dlg;
  };
  it("delete success: Delete, confirm Yes, then the listing is gone", () => {
    load("header-in", "edit-delete");
    openDialogOnDelete();
    expect(step("markSold", U.edit, D)).toEqual({ kind: "wait", phase: "del_confirm", ms: 800 });
    expect(step("markSold", U.edit, D, "del_confirm")).toEqual({ kind: "wait", phase: "del_done", ms: 4000 });
    expect(clicked).toEqual(["Delete Listing", "Yes"]);
    load("header-in", "closet");
    expect(step("markSold", U.closet, D, "del_done")).toEqual({ kind: "done", result: { deleted: true, note: "Deleted on Poshmark" } });
    load("header-in", "notfound");
    expect(step("markSold", U.listing, D, "del_done")).toMatchObject({ kind: "done", result: { deleted: true } });
  });
  it("delete blocked (active offer) -> reopen the edit page and set Not For Sale, reporting the fallback; never cancels the offer", () => {
    load("header-in", "edit-delete");
    const dlg = openDialogOnDelete();
    step("delist", U.edit, D);
    dlg.querySelector("#dlgText")!.textContent = "This listing has an active offer and can't be deleted.";
    expect(step("delist", U.edit, D, "del_confirm")).toEqual({ kind: "goto", page: "edit", phase: "fb-offer-start" });
    expect(clicked).toEqual(["Delete Listing"]); // no "Yes", no "Cancel offer"
    load("header-in", "edit-select");
    expect(step("delist", U.edit, D, "fb-offer-start")).toEqual({ kind: "wait", phase: "fb-offer-saved", ms: 5000 });
    expect((document.getElementById("avail") as HTMLSelectElement).value).toBe("not_for_sale");
    document.body.innerHTML = fx("header-in") + "<main><h1>Nike Polo</h1><span>Not For Sale</span></main>";
    expect(step("delist", U.listing, D, "fb-offer-saved")).toMatchObject({ kind: "done", result: { alreadyDone: false, fallback: expect.stringMatching(/blocked the delete/) } });
  });
  it("no Delete button -> fallback; a missing confirmation stops without deleting; delete refused after Yes -> fallback", () => {
    load("header-in", "edit-select");
    expect(step("delist", U.edit, D)).toEqual({ kind: "goto", page: "edit", phase: "fb-nodelete-start" });
    load("header-in", "edit-delete");
    expect(step("delist", U.edit, D, "del_confirm")).toMatchObject({ kind: "stop", code: "unexpected_page" });
    load("header-in", "edit-delete");
    document.body.insertAdjacentHTML("beforeend", "<div role='alert'>Something went wrong</div>");
    expect(step("delist", U.edit, D, "del_done")).toEqual({ kind: "goto", page: "edit", phase: "fb-refused-start" });
  });
  it("without mode: delete it is Not For Sale only (as before); a captcha mid-delete still stops", () => {
    load("header-in", "edit-delete");
    expect(step("delist", U.edit, { externalId: ID })).toEqual({ kind: "wait", phase: "saved", ms: 5000 });
    expect(clicked).toEqual(["Update"]);
    load("header-in", "captcha");
    expect(step("delist", U.edit, D, "del_confirm")).toMatchObject({ kind: "stop", code: "captcha" });
  });
});

describe("updateQuantity / updateListing / createListing", () => {
  it("quantity: sets the field and saves; quantity 0 means Not For Sale", () => {
    load("header-in", "edit-select");
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 3 })).toMatchObject({ kind: "wait", phase: "saved" });
    expect((document.getElementById("qty") as HTMLInputElement).value).toBe("3");
    load("header-in", "edit-select");
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 1 })).toMatchObject({ kind: "done", result: { alreadyDone: true } });
    step("updateQuantity", U.edit, { externalId: ID, quantity: 0 });
    expect((document.getElementById("avail") as HTMLSelectElement).value).toBe("not_for_sale");
    // Left the edit page after Update: re-open it and check what Poshmark saved.
    expect(step("updateQuantity", U.listing, { externalId: ID, quantity: 3 }, "saved")).toEqual({ kind: "goto", page: "edit", phase: "verify" });
    load("header-in", "edit-select");
    (document.getElementById("qty") as HTMLInputElement).value = "3";
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 3 }, "verify")).toMatchObject({ kind: "done", result: { note: expect.stringMatching(/checked/) } });
  });
  it("updateListing changes only the given fields, never the original price", () => {
    load("header-in", "edit-select");
    expect(step("updateListing", U.edit, { externalId: ID, price: 22, title: "Nike Polo L" })).toMatchObject({ kind: "wait", phase: "saved" });
    expect((document.getElementById("lp") as HTMLInputElement).value).toBe("22");
    expect((document.getElementById("op") as HTMLInputElement).value).toBe("60");
    expect((document.getElementById("title") as HTMLInputElement).value).toBe("Nike Polo L");
    expect((document.getElementById("desc") as HTMLTextAreaElement).value).toBe("Great shirt");
  });
  it("createListing fills a draft and stops for you; it never presses List", () => {
    load("header-in", "create");
    const r = step("createListing", U.create, { title: "Polo", price: 20, description: "Nice", brand: "Nike", originalPrice: 50 });
    expect(r).toMatchObject({ kind: "stop", code: "review_and_submit", keepTab: true });
    const v = (n: string) => (document.querySelector(`[name="${n}"]`) as HTMLInputElement).value;
    expect([v("title"), v("description"), v("brand"), v("original_price"), v("listing_price")]).toEqual(["Polo", "Nice", "Nike", "50", "20"]);
    expect(clicked).toEqual([]);
  });
});

describe("getSales / getListings", () => {
  it("reads sales newer than the cursor (1 day overlap), with listing ids and cancellations", () => {
    load("header-in", "sales");
    const all = parseSales(document, null, 50);
    expect(all.sales.map((s) => s.orderId)).toEqual(["ord0999old", "ord1002def", "ord1001abc"]);
    expect(all.sales[2]).toEqual({ orderId: "ord1001abc", soldAt: "2026-10-17", price: 25, title: "Nike Polo L", externalListingId: ID });
    expect(all.sales[1]).toMatchObject({ soldAt: "2026-10-12", price: 40, cancelled: true });
    const r = step("getSales", U.sales, { cursor: "2026-10-12T15:00:00.000Z" });
    expect(r).toMatchObject({ kind: "done", nextCursor: "2026-10-17T00:00:00.000Z" });
    expect((r as { sales: unknown[] }).sales).toHaveLength(2);
    expect(parseSales(document, "2026-10-18T10:00:00.000Z", 50)).toMatchObject({ nextCursor: null });
  });
  it("signed out on the sales page stops", () => {
    load("header-out", "sales");
    expect(step("getSales", U.sales, {})).toMatchObject({ kind: "stop", code: "signed_out" });
  });
  it("getListings finds your closet, then counts unique listings", () => {
    load("header-in");
    expect(step("getListings", U.home)).toEqual({ kind: "goto", page: "closet", phase: "list", user: "davidsells" });
    load("header-in", "closet");
    expect(step("getListings", U.closet, {}, "list")).toEqual({ kind: "done", listingIds: ["a1b2c3d4e5f6a1b2c3d4e5f6", "b1b2c3d4e5f6a1b2c3d4e5f6"], result: { note: expect.stringMatching(/^2 live listings/) } });
  });
  it("other marketplaces answer not_supported", () => {
    expect(runStep(document, { action: "delist", marketplace: "depop", payload: {}, phase: "start", url: "https://www.depop.com/" })).toMatchObject({ kind: "stop", code: "not_supported" });
  });
});

// The real Edit Listing page (scrubbed from the copy David saved): Vue form, data-vv-name fields, data-et-name buttons, pre-rendered closed modals.
describe("real Poshmark edit page (scrubbed fixture)", () => {
  const real = (v: { title?: string; desc?: string; price?: string } = {}) => {
    load("header-in", "edit-real");
    const set = (sel: string, val: string) => { (document.querySelector(sel) as HTMLInputElement).value = val; };
    set('input[data-vv-name="title"]', v.title ?? "Black jeans W32");
    set('textarea[data-vv-name="description"]', v.desc ?? "Good condition");
    set('input[data-vv-name="listingPrice"]', v.price ?? "20");
    set('input[data-vv-name="originalPrice"]', "60");
  };
  const val = (sel: string) => (document.querySelector(sel) as HTMLInputElement).value;
  const openModal = (text: string) => {
    const m = Array.from(document.querySelectorAll('[data-test="modal-container"]')).find((x) => x.textContent!.includes(text))!;
    m.classList.add("modal--in");
  };

  it("the saved page has what we drive, and nothing hidden is misread (closed modals, hidden errors, menus)", () => {
    real();
    for (const sel of ['input[data-vv-name="title"]', 'textarea[data-vv-name="description"]', 'input[data-vv-name="listingPrice"]', 'button[data-et-name="update"]',
      '[data-et-name="delete"]', '[data-et-name="listingEditorAvailabilitySection"] [data-et-name="not_for_sale"]', 'button[data-et-name="one"]', 'button[data-et-name="multiple"]'])
      expect(document.querySelector(sel), sel).not.toBeNull();
    expect(document.querySelector('input[data-vv-name*="quantity" i]')).toBeNull(); // Single Item listing: no quantity box at all
    expect(fx("edit-real")).not.toMatch(/<script|6ad5e74c|davidsells/i); // scrubbed
    expect(signedIn(document)).toBe(true);
    expect(step("updateListing", U.edit, { externalId: ID, price: 20 })).toMatchObject({ kind: "done", result: { alreadyDone: true } }); // not "not found", not "error"
  });

  it("updateListing: sets title / price by their data-vv-name, presses Update, then confirms on a fresh edit page", () => {
    real();
    expect(step("updateListing", U.edit, { externalId: ID, price: 25, title: "Black jeans W32 L30" })).toEqual({ kind: "wait", phase: "saved", ms: 5000 });
    expect(val('input[data-vv-name="listingPrice"]')).toBe("25");
    expect(val('input[data-vv-name="originalPrice"]')).toBe("60");
    expect(val('input[data-vv-name="title"]')).toBe("Black jeans W32 L30");
    expect(clicked).toEqual(["Update"]);
    // still on the edit page, no message: wait once more, then stop and leave the tab open
    expect(step("updateListing", U.edit, { externalId: ID, price: 25 }, "saved")).toEqual({ kind: "wait", phase: "saved2", ms: 5000 });
    expect(step("updateListing", U.edit, { externalId: ID, price: 25 }, "saved2")).toMatchObject({ kind: "stop", code: "unexpected_page", keepTab: true });
    // left the edit page (listing page, closet, anywhere): re-open the edit page and compare
    expect(step("updateListing", U.listing, { externalId: ID, price: 25 }, "saved")).toEqual({ kind: "goto", page: "edit", phase: "verify" });
    expect(step("updateListing", U.closet, { externalId: ID, price: 25 }, "saved2")).toEqual({ kind: "goto", page: "edit", phase: "verify" });
    real({ price: "25", title: "Black jeans W32 L30" });
    expect(step("updateListing", U.edit, { externalId: ID, price: 25, title: "Black jeans W32 L30" }, "verify")).toMatchObject({ kind: "done", result: { note: expect.stringMatching(/checked/) } });
    real({ price: "20" });
    expect(step("updateListing", U.edit, { externalId: ID, price: 25 }, "verify")).toMatchObject({ kind: "stop", code: "unexpected_page", message: expect.stringContaining("price") });
    real({ price: "" });
    expect(step("updateListing", U.edit, { externalId: ID, price: 25 }, "verify")).toEqual({ kind: "wait", phase: "verify2", ms: 1500 }); // still loading
  });

  it("a modal after Update (e.g. 'Problem Detected') or a shown field error stops with Poshmark's words", () => {
    real();
    openModal("Problem Detected");
    expect(step("updateListing", U.edit, { externalId: ID, price: 25 }, "saved")).toMatchObject({ kind: "stop", code: "rejected", keepTab: true, message: expect.stringContaining("Problem Detected") });
    real();
    const err = Array.from(document.querySelectorAll<HTMLElement>(".form__error-message")).find((e) => /Invalid Price/.test(e.textContent!))!;
    err.style.display = "block";
    expect(step("updateListing", U.edit, { externalId: ID, price: 25 }, "saved")).toMatchObject({ kind: "stop", code: "rejected", message: expect.stringContaining("Invalid Price") });
  });

  it("updateQuantity on a Single Item listing (no quantity box): 1 is already true; more stops and says why; Multi Item uses the box", () => {
    real();
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 1 })).toMatchObject({ kind: "done", result: { alreadyDone: true, note: expect.stringMatching(/Single Item/) } });
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 3 })).toMatchObject({ kind: "stop", code: "unexpected_page", message: expect.stringMatching(/Single Item listing.*Multi Item/) });
    expect(clicked).toEqual([]); // never switches Single -> Multi by itself
    const one = document.querySelector('button[data-et-name="one"]')!, many = document.querySelector('button[data-et-name="multiple"]')!;
    one.className = "btn btn--tertiary"; many.className = "btn btn--primary";
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 3 })).toMatchObject({ kind: "stop", message: expect.stringMatching(/Multi Item listing, but no quantity box/) });
    many.insertAdjacentHTML("afterend", '<input type="text" data-vv-name="quantity" value="1">');
    expect(step("updateQuantity", U.edit, { externalId: ID, quantity: 3 })).toEqual({ kind: "wait", phase: "saved", ms: 5000 });
    expect(val('input[data-vv-name="quantity"]')).toBe("3");
    expect(clicked).toEqual(["Update"]);
  });

  it("Not For Sale: opens the Availability menu, picks not_for_sale, checks it took, presses Update, then checks on a fresh page", () => {
    real();
    expect(step("delist", U.edit, { externalId: ID })).toEqual({ kind: "wait", phase: "pick", ms: 800 }); // the hidden "Not For Sale" menu text is not misread
    expect(step("delist", U.edit, { externalId: ID }, "pick")).toEqual({ kind: "wait", phase: "picked", ms: 700 });
    expect(clicked.at(-1)).toBe("Not For Sale");
    expect(step("delist", U.edit, { externalId: ID }, "picked")).toMatchObject({ kind: "stop", code: "unexpected_page" }); // the menu did not change
    const shown = document.querySelector('[data-et-name="listingEditorAvailabilitySection"] [data-test="dropdown-container"] span')!;
    shown.textContent = "Not For Sale";
    clicked = [];
    expect(step("delist", U.edit, { externalId: ID }, "picked")).toEqual({ kind: "wait", phase: "saved", ms: 5000 });
    expect(clicked).toEqual(["Update"]);
    expect(step("delist", U.edit, { externalId: ID }, "verify")).toMatchObject({ kind: "done", result: { note: expect.stringMatching(/checked/) } });
    expect(step("delist", U.edit, { externalId: ID })).toMatchObject({ kind: "done", result: { alreadyDone: true } });
  });

  it("delete: Delete Listing, then Yes in the 'Confirm Delete Listing' modal once it is open; never clicks a closed modal", () => {
    const D = { externalId: ID, mode: "delete" };
    real();
    expect(step("markSold", U.edit, D)).toEqual({ kind: "wait", phase: "del_confirm", ms: 800 });
    expect(clicked).toEqual(["Delete Listing"]);
    clicked = [];
    expect(step("markSold", U.edit, D, "del_confirm")).toMatchObject({ kind: "stop", code: "unexpected_page" }); // modal still closed
    expect(clicked).toEqual([]);
    openModal("want to delete this item");
    expect(step("markSold", U.edit, D, "del_confirm")).toEqual({ kind: "wait", phase: "del_done", ms: 4000 });
    expect(clicked).toEqual(["Yes"]);
  });
});
