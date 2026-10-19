// Filled in by build.mjs (esbuild define). The fallbacks only apply in unit tests.
declare const __API_ORIGIN__: string | undefined;
declare const __EXT_VERSION__: string | undefined;
export const API_ORIGIN: string = typeof __API_ORIGIN__ === "string" ? __API_ORIGIN__ : "https://shadowsync-ruby.vercel.app";
export const EXT_VERSION: string = typeof __EXT_VERSION__ === "string" ? __EXT_VERSION__ : "0.1.0";
