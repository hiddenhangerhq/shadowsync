// Brand colors are DATA (they identify a marketplace), not theme tokens. They are always shown as a
// dot with a ring in the theme text color so they stay visible on every background.
export const BRAND_COLORS: Record<string, string> = {
  ebay: "#e53238", poshmark: "#7b2d4f", depop: "#ff2300", whatnot: "#ffb800", grailed: "#6b6b6b",
  etsy: "#f1641e", mercari: "#4dc9ff", shopify: "#5e8e3e", wix: "#0c6efc",
};
export const brandColor = (m: string | null | undefined) => (m && BRAND_COLORS[m.toLowerCase()]) || "#8a8a8a";
