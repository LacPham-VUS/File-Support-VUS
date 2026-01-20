import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

export interface ProcessPDFResult {
  success: boolean;
  processedImageUrl?: string;
  error?: string;
}

type RedDetectionTuning = {
  // HSV thresholds for red detection
  sMin: number;
  vMin: number;
  // Hue ranges (0-360). Red is usually around 0 and 360.
  hueA: [number, number];
  hueB: [number, number];
  // mask expand radius (pixels)
  dilateRadius: number;
  // inpaint radius (pixels)
  inpaintRadius: number;
};

const DEFAULT_TUNING: RedDetectionTuning = {
  sMin: 0.35,
  vMin: 0.25,
  hueA: [0, 25],
  hueB: [330, 360],
  dilateRadius: 1,
  inpaintRadius: 2,
};

/**
 * Xử lý ảnh PDF để xóa các đường viết màu đỏ sử dụng Gemini AI
 */
export async function removeRedMarkings(imageData: string): Promise<ProcessPDFResult> {
  try {
    const tuning = await getTuningFromGemini(imageData);
    const processedImage = await processImageRemoveRed(imageData, tuning);

    return {
      success: true,
      processedImageUrl: processedImage,
    };
  } catch (error) {
    console.error('Error processing with Gemini AI:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

async function getTuningFromGemini(imageDataUrl: string): Promise<RedDetectionTuning> {
  // Không có key thì chạy local algorithm luôn
  if (!genAI) return DEFAULT_TUNING;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt =
      'You will receive a scanned document image that contains red teacher markings (ticks, circles, underlines). ' +
      'Return ONLY valid JSON (no markdown) with recommended HSV thresholds to detect red ink while keeping black text. ' +
      'Schema: {"sMin":0..1,"vMin":0..1,"hueA":[0..360,0..360],"hueB":[0..360,0..360],"dilateRadius":0..3,"inpaintRadius":1..5}. ' +
      'Use hue ranges around red (near 0 and near 360).';

    const base64Data = imageDataUrl.split(',')[1];
    if (!base64Data) return DEFAULT_TUNING;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Data,
          mimeType: 'image/png',
        },
      },
    ]);

    const text = result.response.text();
    const json = extractJsonObject(text);
    if (!json) return DEFAULT_TUNING;

    const parsed = JSON.parse(json) as Partial<RedDetectionTuning>;
    return {
      sMin: clamp01(parsed.sMin ?? DEFAULT_TUNING.sMin),
      vMin: clamp01(parsed.vMin ?? DEFAULT_TUNING.vMin),
      hueA: normalizeHueRange(parsed.hueA ?? DEFAULT_TUNING.hueA),
      hueB: normalizeHueRange(parsed.hueB ?? DEFAULT_TUNING.hueB),
      dilateRadius: clampInt(parsed.dilateRadius ?? DEFAULT_TUNING.dilateRadius, 0, 3),
      inpaintRadius: clampInt(parsed.inpaintRadius ?? DEFAULT_TUNING.inpaintRadius, 1, 5),
    };
  } catch {
    return DEFAULT_TUNING;
  }
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.round(value);
  return Math.max(min, Math.min(max, n));
}

function normalizeHueRange(range: [number, number]): [number, number] {
  const a = ((range[0] % 360) + 360) % 360;
  const b = ((range[1] % 360) + 360) % 360;
  return [a, b];
}

/**
 * Xử lý ảnh để loại bỏ màu đỏ (RGB processing)
 */
async function processImageRemoveRed(imageDataUrl: string, tuning: RedDetectionTuning): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      const width = canvas.width;
      const height = canvas.height;

      // 1) Tạo mask pixel đỏ
      const mask = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx] / 255;
          const g = data[idx + 1] / 255;
          const b = data[idx + 2] / 255;
          const a = data[idx + 3];
          if (a < 10) continue;

          const { h, s, v } = rgbToHsv(r, g, b);
          if (s < tuning.sMin || v < tuning.vMin) continue;

          const isRed =
            inHueRange(h, tuning.hueA[0], tuning.hueA[1]) || inHueRange(h, tuning.hueB[0], tuning.hueB[1]);
          if (isRed) {
            mask[y * width + x] = 1;
          }
        }
      }

      // 2) Dilation nhẹ để bao phủ nét đỏ
      const dilated = dilateMask(mask, width, height, tuning.dilateRadius);

      // 3) Inpaint đơn giản: thay pixel đỏ bằng trung bình lân cận không-màu-đỏ
      const out = new Uint8ClampedArray(data);
      const radius = tuning.inpaintRadius;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!dilated[y * width + x]) continue;

          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          let count = 0;

          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              if (dilated[ny * width + nx]) continue;

              const nIdx = (ny * width + nx) * 4;
              sumR += out[nIdx];
              sumG += out[nIdx + 1];
              sumB += out[nIdx + 2];
              count++;
            }
          }

          const oIdx = (y * width + x) * 4;
          if (count > 0) {
            out[oIdx] = Math.round(sumR / count);
            out[oIdx + 1] = Math.round(sumG / count);
            out[oIdx + 2] = Math.round(sumB / count);
          } else {
            // fallback: trắng
            out[oIdx] = 255;
            out[oIdx + 1] = 255;
            out[oIdx + 2] = 255;
          }
        }
      }

      imageData.data.set(out);

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };

    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageDataUrl;
  });
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

function inHueRange(h: number, a: number, b: number): boolean {
  // if a <= b normal range; else wraps around 360
  if (a <= b) return h >= a && h <= b;
  return h >= a || h <= b;
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

export default {
  removeRedMarkings,
};
