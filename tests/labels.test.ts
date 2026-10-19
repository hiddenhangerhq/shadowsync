// Plain-words job labels (David, 2026-10-19): one pure function for the web app and the extension.
import { describe, expect, it } from "vitest";
import { actionLabel, jobEventLabel, jobLabel, marketplaceName, statusWord } from "../src/lib/jobs/labels";
import { ACTIONS } from "../src/lib/ext/protocol";
import { JOB_STATUSES, JOB_TYPES } from "../src/lib/data/types";

describe("actionLabel: every action", () => {
  it("reads like a sentence, with the values", () => {
    expect(actionLabel("checkLogin")).toBe("Check sign-in");
    expect(actionLabel("getSales", { cursor: "x", limit: 50 })).toBe("Scan sales");
    expect(actionLabel("getListings")).toBe("Count listings");
    expect(actionLabel("updateQuantity", { quantity: 2 })).toBe("Set quantity to 2");
    expect(actionLabel("updateQuantity", { quantity: 0 })).toBe("Set quantity to 0 (Not For Sale)");
    expect(actionLabel("updateQuantity", {})).toBe("Set quantity");
    expect(actionLabel("updateListing", { price: 25 })).toBe("Change price to $25.00");
    expect(actionLabel("updateListing", { title: "Black jeans" })).toBe("Change title to 'Black jeans'");
    expect(actionLabel("updateListing", { price: 25, title: "Black jeans" })).toBe("Change price to $25.00 and title to 'Black jeans'");
    expect(actionLabel("updateListing", { description: "new" })).toBe("Change description");
    expect(actionLabel("updateListing", {})).toBe("Edit listing");
    expect(actionLabel("delist", {})).toBe("Set Not For Sale");
    expect(actionLabel("delist", { mode: "not_for_sale" })).toBe("Set Not For Sale");
    expect(actionLabel("delist", { saleId: "s1", mode: "delete" })).toBe("Delete listing (sold)");
    expect(actionLabel("markSold", { saleId: "s1", mode: "delete" })).toBe("Delete listing (sold)");
    expect(actionLabel("markSold", { saleId: "s1", mode: "not_for_sale" })).toBe("Set Not For Sale (sold)");
    expect(actionLabel("markSold", { mode: "not_for_sale" })).toBe("Set Not For Sale (sold)");
    expect(actionLabel("createListing", { title: "Polo", price: 30 })).toBe("Create listing draft 'Polo' at $30.00");
    expect(actionLabel("createListing", {})).toBe("Create listing draft");
    for (const a of ACTIONS) expect(actionLabel(a, {})).toMatch(/^[A-Z][^_]+$/); // never a raw code
  });
  it("old -> new where known, and long titles are shortened", () => {
    expect(actionLabel("updateListing", { price: 25, previous: { price: 30 } })).toBe("Change price: $30.00 -> $25.00");
    expect(actionLabel("updateListing", { price: 25, previous: { price: 25 } })).toBe("Change price to $25.00");
    expect(actionLabel("updateListing", { title: "Black jeans", previous: { title: "Jeans black" } })).toBe("Change title: 'Jeans black' -> 'Black jeans'");
    expect(actionLabel("updateQuantity", { quantity: 0, previous: { quantity: 2 } })).toBe("Set quantity: 2 -> 0 (Not For Sale)");
    expect(actionLabel("updateListing", { title: "x".repeat(100) })).toBe(`Change title to '${"x".repeat(57)}...'`);
  });
  it("queued sold jobs (no mode yet) follow the marketplace setting, default delete", () => {
    expect(actionLabel("markSold", { saleId: "s1" })).toBe("Delete listing (sold)");
    expect(actionLabel("markSold", { saleId: "s1" }, { soldAction: "not_for_sale" })).toBe("Set Not For Sale (sold)");
  });
});

describe("jobLabel / statuses", () => {
  it("maps every job type through the same action", () => {
    expect(jobLabel({ jobType: "update_listing", payload: { quantity: 2 } })).toBe("Set quantity to 2");
    expect(jobLabel({ jobType: "update_listing", payload: { price: 25, previous: { price: 30 } } })).toBe("Change price: $30.00 -> $25.00");
    expect(jobLabel({ jobType: "sync_status", payload: {} })).toBe("Count listings");
    expect(jobLabel({ jobType: "delist", payload: {} })).toBe("Set Not For Sale");
    expect(jobLabel({ jobType: "mark_sold", payload: { saleId: "s" } })).toBe("Delete listing (sold)");
    expect(jobLabel({ jobType: "create_listing", payload: null })).toBe("Create listing draft");
    for (const t of JOB_TYPES) expect(jobLabel({ jobType: t, payload: {} })).toMatch(/^[A-Z]/);
  });
  it("status lines: the marketplace on the queued line, the same label after", () => {
    expect(jobEventLabel("queued", "Set quantity to 2", "poshmark")).toBe("Queued: Set quantity to 2 on Poshmark");
    expect(jobEventLabel("running", "Set quantity to 2", "poshmark")).toBe("Running: Set quantity to 2");
    expect(jobEventLabel("succeeded", "Set quantity to 2", "poshmark")).toBe("Succeeded: Set quantity to 2");
    expect(jobEventLabel("failed", "Change price to $25.00")).toBe("Failed: Change price to $25.00");
    for (const s of JOB_STATUSES) expect(statusWord(s)).toMatch(/^[A-Z][a-z ]+$/);
    expect(marketplaceName("ebay")).toBe("eBay");
  });
});
