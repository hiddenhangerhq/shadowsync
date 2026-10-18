export interface Size { width: number; height: number }

/** Scale (w,h) down so the longest edge is <= max. Never upscales. */
export function fitWithin(w: number, h: number, max: number): Size {
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const s = max / longest;
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

export interface Resized { blob: Blob; width: number; height: number }

/** Browser only. Resizes + recompresses to JPEG; EXIF orientation is applied by createImageBitmap. */
export async function resizeImage(file: File, max = 1600, quality = 0.82): Promise<Resized> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fitWithin(bmp.width, bmp.height, max);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) throw new Error("Could not compress image");
  return { blob, width, height };
}
