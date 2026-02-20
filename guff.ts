#!/usr/bin/env bun

import { parseArgs } from "util";
import { resolve, basename, extname, join } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import sharp from "sharp";

const RESOLUTIONS: Record<string, string> = {
  "1k": "1K",
  "2k": "2K",
  "4k": "4K",
};

const PROVIDERS: Record<string, (opts: GenerateOpts) => Promise<Buffer>> = {
  gemini: generateGemini,
};

const ASPECT_RATIOS = [
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
];

interface InputImage {
  mimeType: string;
  data: string; // base64
}

interface GenerateOpts {
  model: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  temperature: number;
  debug: boolean;
  inputImages: InputImage[];
}

function usage(): never {
  console.log(`Usage: guff [options] <prompt>

Generate animated GIFs using AI.

Options:
  -f, --frames <n>             Number of animation frames (default: 4)
  -D, --delay <ms>             Delay between frames in ms (default: 250)
  -s, --size <WxH>             Output size (default: 128x128)
  -a, --aspect <W:H>           Frame aspect ratio (default: 1:1)
  -o, --output <file>          Output filename (default: auto-generated)
  -i, --input <file>           Input image(s) for reference (repeatable)
  -r, --resolution <res>       Resolution: 1k, 2k, 4k (default: 1k)
  -t, --temperature <temp>     Temperature 0.0-2.0 (default: 1.0)
  -m, --model <provider/model> Model (default: gemini/gemini-3-pro-image-preview)
  -d, --debug                  Log full prompt and API details
  -h, --help                   Show this help

Requires: gifsicle (brew install gifsicle)

Examples:
  guff 'a dancing penguin'
  guff --frames 4 --delay 250 --size 128x128 --output penguin.gif 'a dancing penguin'
  guff -f 8 -s 256x256 'a spinning coin'
  guff -i ref.png 'animate this character waving'`);
  process.exit(0);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    frames: { type: "string", short: "f", default: "4" },
    delay: { type: "string", short: "D", default: "250" },
    size: { type: "string", short: "s", default: "128x128" },
    output: { type: "string", short: "o" },
    input: { type: "string", short: "i", multiple: true },
    resolution: { type: "string", short: "r", default: "1k" },
    temperature: { type: "string", short: "t", default: "1.0" },
    model: {
      type: "string",
      short: "m",
      default: "gemini/gemini-3-pro-image-preview",
    },
    aspect: { type: "string", short: "a", default: "1:1" },
    debug: { type: "boolean", short: "d", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) usage();

const prompt = positionals[0];
if (!prompt) {
  console.error("Error: prompt is required. Use --help for usage.");
  process.exit(1);
}

// Validate frames
const numFrames = parseInt(values.frames!, 10);
if (isNaN(numFrames) || numFrames < 2 || numFrames > 16) {
  console.error("Error: frames must be between 2 and 16");
  process.exit(1);
}

// Validate delay
const delay = parseInt(values.delay!, 10);
if (isNaN(delay) || delay < 10 || delay > 10000) {
  console.error("Error: delay must be between 10 and 10000 ms");
  process.exit(1);
}

// Parse size
const sizeMatch = values.size!.match(/^(\d+)x(\d+)$/);
if (!sizeMatch) {
  console.error("Error: size must be in WxH format (e.g., 128x128)");
  process.exit(1);
}
const outputW = parseInt(sizeMatch[1]!, 10);
const outputH = parseInt(sizeMatch[2]!, 10);

// Parse provider/model
const modelStr = values.model!;
const slashIdx = modelStr.indexOf("/");
const provider = slashIdx !== -1 ? modelStr.slice(0, slashIdx) : "gemini";
const modelName = slashIdx !== -1 ? modelStr.slice(slashIdx + 1) : modelStr;

const generateFn = PROVIDERS[provider];
if (!generateFn) {
  console.error(
    `Error: unsupported provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
  );
  process.exit(1);
}

// Parse resolution
const resKey = values.resolution!.toLowerCase();
const imageSize = RESOLUTIONS[resKey];
if (!imageSize) {
  console.error(
    `Error: unknown resolution "${values.resolution}". Use: ${Object.keys(RESOLUTIONS).join(", ")}`
  );
  process.exit(1);
}

// Parse temperature
const temperature = parseFloat(values.temperature!);
if (isNaN(temperature) || temperature < 0 || temperature > 2) {
  console.error("Error: temperature must be between 0.0 and 2.0");
  process.exit(1);
}

// Parse frame aspect ratio
const frameARMatch = values.aspect!.match(/^(\d+):(\d+)$/);
if (!frameARMatch) {
  console.error(
    "Error: aspect must be in W:H format (e.g., 1:1, 16:9, 4:3)"
  );
  process.exit(1);
}
const frameAR =
  parseInt(frameARMatch[1]!, 10) / parseInt(frameARMatch[2]!, 10);

// Check gifsicle is available
try {
  execFileSync("gifsicle", ["--version"], { stdio: "pipe" });
} catch {
  console.error(
    "Error: gifsicle is required but not found. Install with: brew install gifsicle"
  );
  process.exit(1);
}

// Compute grid layout for N frames — find the most square-like factor pair
function gridLayout(n: number): { cols: number; rows: number } {
  let bestCols = n,
    bestRows = 1;
  for (let r = 2; r * r <= n; r++) {
    if (n % r === 0) {
      bestCols = n / r;
      bestRows = r;
    }
  }
  return { cols: bestCols, rows: bestRows };
}

function bestAspectRatio(
  cols: number,
  rows: number,
  frameAR: number
): string {
  const target = (cols * frameAR) / rows;
  let best = ASPECT_RATIOS[0]!;
  let bestDist = Infinity;
  for (const r of ASPECT_RATIOS) {
    const dist = Math.abs(Math.log(r.value / target));
    if (dist < bestDist) {
      bestDist = dist;
      best = r;
    }
  }
  return best.label;
}

const { cols, rows } = gridLayout(numFrames);

// Validate that the grid isn't just a single long row (primes > 3)
if (rows === 1 && cols > 3) {
  const suggest: number[] = [];
  for (let n = numFrames - 1; n >= 2; n--) {
    const { rows: r } = gridLayout(n);
    if (r > 1 || n <= 3) {
      suggest.push(n);
      break;
    }
  }
  for (let n = numFrames + 1; n <= 16; n++) {
    const { rows: r } = gridLayout(n);
    if (r > 1 || n <= 3) {
      suggest.push(n);
      break;
    }
  }
  console.error(
    `Error: ${numFrames} frames can't form a clean grid (only ${cols}x1). Try: ${suggest.join(" or ")}`
  );
  process.exit(1);
}

const aspectRatio = bestAspectRatio(cols, rows, frameAR);

// Build prompt for animation frames
const fullPrompt = [
  `Generate a ${cols}x${rows} grid of ${numFrames} animation frames showing: ${prompt}`,
  ``,
  `CRITICAL INSTRUCTIONS:`,
  `- Create exactly ${numFrames} frames arranged in a ${cols}-column, ${rows}-row grid`,
  `- Frame order: left-to-right, top-to-bottom (frame 1 is top-left)`,
  `- Each frame shows the next step in a smooth, looping animation`,
  `- Use a plain white background in all frames`,
  `- All frames must be exactly the same size with clear, straight boundaries between them`,
  `- Do NOT draw borders, lines, or dividers between frames`,
  `- The animation should loop seamlessly from the last frame back to the first`,
  `- Each frame should have ${values.aspect} aspect ratio`,
  `- Keep the subject centered and consistently sized across all frames`,
  `- ABSOLUTELY NO text of any kind in the image: no frame numbers, no labels, no captions, no watermarks, no annotations`,
].join("\n");

if (values.debug) {
  console.log("--- Prompt ---");
  console.log(fullPrompt);
  console.log(`--- Grid: ${cols}x${rows}, Aspect ratio: ${aspectRatio} ---`);
}

// Load input images
const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const inputImages: InputImage[] = [];
for (const file of values.input ?? []) {
  const path = resolve(file);
  if (!existsSync(path)) {
    console.error(`Error: input file not found: ${file}`);
    process.exit(1);
  }
  const ext = extname(path).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    console.error(
      `Error: unsupported image format "${ext}". Use: ${Object.keys(MIME_TYPES).join(", ")}`
    );
    process.exit(1);
  }
  const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString(
    "base64"
  );
  inputImages.push({ mimeType, data });
}

// Generate image
console.log(`Generating ${numFrames}-frame animation...`);
const imageBuffer = await generateFn({
  model: modelName,
  prompt: fullPrompt,
  aspectRatio,
  imageSize,
  temperature,
  debug: values.debug!,
  inputImages,
});

// In debug mode, save the raw unsliced image
if (values.debug) {
  const debugPath = resolve("debug-unsliced.png");
  await sharp(imageBuffer).png().toFile(debugPath);
  console.log(`--- Saved unsliced image: ${debugPath} ---`);
}

// Split generated image into frames
const metadata = await sharp(imageBuffer).metadata();
const imgW = metadata.width!;
const imgH = metadata.height!;

// Detect actual grid dimensions (Gemini sometimes adds extra rows)
const expectedFrameW = imgW / cols;
const expectedFrameH = expectedFrameW / frameAR;
const detectedRows = Math.round(imgH / expectedFrameH);
let actualRows = rows;
if (detectedRows !== rows) {
  console.log(
    `Warning: detected ${detectedRows} rows (expected ${rows}), adjusting`
  );
  actualRows = detectedRows;
}

const frameW = Math.floor(imgW / cols);
const frameH = Math.floor(imgH / actualRows);

if (values.debug) {
  console.log(
    `--- Image: ${imgW}x${imgH}, Frame: ${frameW}x${frameH}, Grid: ${cols}x${actualRows} ---`
  );
}

// Extract raw frames with 3% inset to crop grid borders
const insetX = Math.max(1, Math.round(frameW * 0.03));
const insetY = Math.max(1, Math.round(frameH * 0.03));

const rawFrames: Buffer[] = [];
for (let row = 0; row < actualRows && rawFrames.length < numFrames; row++) {
  for (let col = 0; col < cols && rawFrames.length < numFrames; col++) {
    const frame = await sharp(imageBuffer)
      .extract({
        left: col * frameW + insetX,
        top: row * frameH + insetY,
        width: frameW - insetX * 2,
        height: frameH - insetY * 2,
      })
      .toBuffer();
    rawFrames.push(frame);
  }
}

// Trim whitespace from each frame and find max dimensions
const trimmed: { data: Buffer; width: number; height: number }[] = [];
let maxTrimW = 0,
  maxTrimH = 0;
for (const raw of rawFrames) {
  const { data, info } = await sharp(raw)
    .trim({ threshold: 20 })
    .toBuffer({ resolveWithObject: true });
  trimmed.push({ data, width: info.width, height: info.height });
  maxTrimW = Math.max(maxTrimW, info.width);
  maxTrimH = Math.max(maxTrimH, info.height);
}

if (values.debug) {
  console.log(
    `--- Trimmed max: ${maxTrimW}x${maxTrimH} ---`
  );
}

// Center each trimmed frame on a uniform canvas, then resize to output
// (composite and resize must be separate steps — sharp applies resize before composite)
const frames: Buffer[] = [];
for (const t of trimmed) {
  const composited = await sharp({
    create: {
      width: maxTrimW,
      height: maxTrimH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: t.data,
        left: Math.round((maxTrimW - t.width) / 2),
        top: Math.round((maxTrimH - t.height) / 2),
      },
    ])
    .png()
    .toBuffer();
  const frame = await sharp(composited)
    .resize(outputW, outputH, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .toBuffer();
  frames.push(frame);
}

// Assemble GIF with gifsicle
const tmpDir = join(tmpdir(), `guff-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

try {
  // Write individual frames as GIF files
  const frameFiles: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const framePath = join(tmpDir, `frame-${i}.gif`);
    await sharp(frames[i]!).gif().toFile(framePath);
    frameFiles.push(framePath);
  }

  // Output filename
  const outputPath = uniquePath(
    values.output ? resolve(values.output) : resolve(`${slugify(prompt)}.gif`)
  );

  // Merge and optimize with gifsicle
  const delayCs = Math.round(delay / 10); // ms → centiseconds
  execFileSync("gifsicle", [
    "--delay",
    String(delayCs),
    "--loop",
    "-O3",
    ...frameFiles,
    "-o",
    outputPath,
  ]);

  console.log(`Saved ${basename(outputPath)}`);
  await displayInTerminal(outputPath);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// --- Helpers ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const base = p.slice(0, -ext.length);
  let n = 2;
  while (existsSync(`${base}-${n}${ext}`)) n++;
  return `${base}-${n}${ext}`;
}

// --- Terminal inline image display ---

async function displayInTerminal(path: string) {
  const term = process.env.TERM_PROGRAM;
  const fileData = Buffer.from(await Bun.file(path).arrayBuffer());

  if (term === "iTerm.app") {
    // iTerm2 inline image protocol (supports GIF natively)
    const b64 = fileData.toString("base64");
    const name = Buffer.from(basename(path)).toString("base64");
    process.stdout.write(
      `\x1b]1337;File=inline=1;name=${name};size=${fileData.length}:${b64}\x07`
    );
    process.stdout.write("\n");
  } else if (term === "ghostty") {
    // Kitty graphics protocol — convert first frame to PNG for display
    const pngData = await sharp(fileData, { animated: false }).png().toBuffer();
    const b64 = pngData.toString("base64");
    const CHUNK_SIZE = 4096;
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      const chunk = b64.slice(i, i + CHUNK_SIZE);
      const isLast = i + CHUNK_SIZE >= b64.length;
      if (i === 0) {
        process.stdout.write(
          `\x1b_Ga=T,f=100,m=${isLast ? 0 : 1};${chunk}\x1b\\`
        );
      } else {
        process.stdout.write(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
      }
    }
    process.stdout.write("\n");
  }
}

// --- Provider implementations ---

async function generateGemini(opts: GenerateOpts): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is required");
    process.exit(1);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${apiKey}`;

  const parts: any[] = opts.inputImages.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  parts.push({ text: opts.prompt });

  const body = {
    contents: [{ parts }],
    generation_config: {
      response_modalities: ["TEXT", "IMAGE"],
      temperature: opts.temperature,
      image_config: {
        aspect_ratio: opts.aspectRatio,
        image_size: opts.imageSize,
      },
    },
  };

  if (opts.debug) {
    console.log("--- API Request ---");
    console.log(`POST ${url.replace(apiKey, "***")}`);
    console.log(JSON.stringify(body, null, 2));
    console.log("-------------------");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Error: Gemini API returned ${res.status}: ${err}`);
    process.exit(1);
  }

  const data: any = await res.json();
  const candidate = data.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (p: any) => p.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    console.error("Error: no image data in API response");
    if (opts.debug) console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  return Buffer.from(imagePart.inlineData.data, "base64");
}
