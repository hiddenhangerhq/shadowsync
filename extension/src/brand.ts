// The ONE place the product name lives ("Shadow Sync" is a placeholder). Used by the manifest, the popup (build fills popup.html)
// and the README (build rewrites <!--brand-->…<!--/brand--> and <!--extname-->…<!--/extname--> spans).
export const BRAND = "Shadow Sync";
export const EXT_NAME = `${BRAND} Crosslist Extension`;
/** Chrome shows at most 132 characters. */
export const EXT_DESCRIPTION = `Connect and crosslist to Poshmark, Depop, Grailed and more with ${BRAND}.`;
