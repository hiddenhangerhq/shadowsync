/// <reference types="chrome" />
import { emptyState, type ExtState, type Store } from "./worker";
const KEY = "shadowsync";
// chrome.storage.local only (never sync): the device token stays on this computer.
export const chromeStore: Store = {
  async load() { const r = await chrome.storage.local.get(KEY); return { ...emptyState(), ...((r[KEY] as Partial<ExtState> | undefined) ?? {}) }; },
  async save(s: ExtState) { await chrome.storage.local.set({ [KEY]: s }); },
};
