/**
 * 图片 → 适合发给模型的 base64。
 *
 * 为什么要过 canvas 而不是直接读 base64：
 *  1. iPhone 拍的 HEIC 能到 4~8MB，Safari 的 <input> 有时给的就是 HEIC 原图；
 *     经 canvas 重编码一次就统一成 JPEG，模型全都吃。
 *  2. 长边压到 1600px：模型看文字足够，token 却省一大截。
 *  3. 顺手解决了方向问题（EXIF 旋转在 drawImage 时会被烘焙进像素）。
 */
export interface ImagePart {
  mimeType: string;
  data: string;
}

const MAX_EDGE = 1600;
const QUALITY = 0.85;

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 落到 <img> 兜底 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    // 解码完就能撤销了，img 元素仍持有像素
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function fileToImagePart(file: File): Promise<ImagePart> {
  const bitmap = await loadBitmap(file);
  const width = "width" in bitmap ? bitmap.width : 0;
  const height = "height" in bitmap ? bitmap.height : 0;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持 canvas，无法处理图片");
  context.drawImage(bitmap as CanvasImageSource, 0, 0, targetWidth, targetHeight);

  const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  return { mimeType: "image/jpeg", data: base64 };
}

/** base64 → data URL（列表里显示用）。 */
export function imageSrc(part: ImagePart): string {
  return `data:${part.mimeType};base64,${part.data}`;
}
