// Photo prep, entirely in the browser (iPhone Safari, Chrome on Android): decode, shrink, re-encode as JPEG.
//
// Size: 1600 px on the long side. Gemini 3 bills an image by its media resolution, not its pixels (we send
// "high", 1073 tokens), but more source pixels still help it read small print. In a test with a nutrition
// label filling a sixth of a tilted phone photo, 1024 and 1280 px misread values at every resolution, while
// 1600 px + high read all of them in 4 of 4 runs. That also keeps uploads around 150-400 KB.
//
// Re-encoding also drops EXIF metadata, including GPS location.

export const PHOTO_MAX_SIDE = 1600;
const QUALITY = 0.82;
const MAX_BYTES = 1.5 * 1024 * 1024; // re-encode smaller past this; the server's hard limit is 5 MB

export type PreparedPhoto = { mime_type: "image/jpeg"; data: string; bytes: number; width: number; height: number };

/** Decodes with EXIF orientation applied (an <img> does this in every current browser), off the main thread. */
async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error("Couldn't read that photo. Try a JPEG or a screenshot.");
  } finally {
    // The decoded bitmap stays usable after the URL is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function draw(target: AnyCanvas, source: CanvasImageSource) {
  const ctx = target.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, target.width, target.height);
}

/**
 * Halves the image until it's within 2x of the target, then does the final resize. One big jump (12 MP to 2 MP)
 * skips source pixels and blurs small print; halving averages them.
 */
function resize(img: HTMLImageElement, maxSide: number): AnyCanvas {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  let source: CanvasImageSource = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  while (sw / 2 >= w * 1.5) {
    sw = Math.round(sw / 2);
    sh = Math.round(sh / 2);
    const step = makeCanvas(sw, sh);
    draw(step, source);
    source = step;
  }
  const out = makeCanvas(w, h);
  draw(out, source);
  return out;
}

/** JPEG encode without blocking the main thread (convertToBlob / toBlob are async; toDataURL is not). */
function encode(canvas: AnyCanvas, quality: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't compress that photo"))), "image/jpeg", quality));
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function preparePhoto(file: File, maxSide = PHOTO_MAX_SIDE): Promise<PreparedPhoto> {
  const img = await decode(file);
  const canvas = resize(img, maxSide);
  let blob = await encode(canvas, QUALITY);
  if (blob.size > MAX_BYTES) blob = await encode(canvas, 0.68); // very busy scenes only
  return { mime_type: "image/jpeg", data: await toBase64(blob), bytes: blob.size, width: canvas.width, height: canvas.height };
}
