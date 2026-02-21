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

const PROVIDERS: Record<string, (opts: GenerateOpts) => Promise<Buffer[]>> = {
  gemini: generateGemini,
  claude: generateClaude,
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
  numFrames: number;
  outputW: number;
  outputH: number;
  cols: number;
  rows: number;
  frameAR: number;
}

function usage(): never {
  console.log(`Usage: guff [options] <prompt>

Generate animated GIFs using AI.

Options:
  -f, --frames <n>             Number of animation frames (default: 32)
  -D, --delay <ms>             Delay between frames in ms (default: 100)
  -s, --size <WxH>             Output size (default: 128x128)
  -a, --aspect <W:H>           Frame aspect ratio (default: 1:1)
  -o, --output <file>          Output filename (default: auto-generated)
  -i, --input <file>           Input image(s) for reference (repeatable)
  -r, --resolution <res>       Resolution: 1k, 2k, 4k (default: 1k, Gemini only)
  -t, --temperature <temp>     Temperature 0.0-2.0 (default: 1.0)
  -m, --model <provider/model> Model (default: claude/claude-sonnet-4-6)
  -c, --colors <n>             Max colors in GIF palette (default: 256)
  -d, --debug                  Log full prompt and API details
  -h, --help                   Show this help

Requires: gifsicle (brew install gifsicle)

Examples:
  guff 'a bouncing ball'
  guff -f 8 -s 256x256 'a spinning star'
  guff -d 'a dancing penguin'
  guff -m gemini/gemini-2-flash-preview-image-generation 'a waving hand'`);
  process.exit(0);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    frames: { type: "string", short: "f", default: "32" },
    delay: { type: "string", short: "D", default: "100" },
    size: { type: "string", short: "s", default: "128x128" },
    output: { type: "string", short: "o" },
    input: { type: "string", short: "i", multiple: true },
    resolution: { type: "string", short: "r", default: "1k" },
    temperature: { type: "string", short: "t", default: "1.0" },
    model: {
      type: "string",
      short: "m",
      default: "claude/claude-sonnet-4-6",
    },
    colors: { type: "string", short: "c", default: "256" },
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
if (isNaN(numFrames) || numFrames < 2 || numFrames > 64) {
  console.error("Error: frames must be between 2 and 64");
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

// Parse colors
const colors = parseInt(values.colors!, 10);
if (isNaN(colors) || colors < 2 || colors > 256) {
  console.error("Error: colors must be between 2 and 256");
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

// Grid validation only applies to Gemini (which generates sprite sheets)
if (provider === "gemini" && rows === 1 && cols > 3) {
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

// Generate frames
console.log(`Generating ${numFrames}-frame animation...`);
const frames = await generateFn({
  model: modelName,
  prompt,
  aspectRatio,
  imageSize,
  temperature,
  debug: values.debug!,
  inputImages,
  numFrames,
  outputW,
  outputH,
  cols,
  rows,
  frameAR,
});

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
    "--colors",
    String(colors),
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

// --- Helpers for Claude provider ---

function extractCode(text: string): string | null {
  const fenced = text.match(/```(?:typescript|ts|)\n([\s\S]*?)```/);
  if (fenced) return fenced[1]!;
  if (text.includes("console.log") && text.includes("JSON.stringify"))
    return text;
  return null;
}

async function executeFrameScript(
  code: string,
  opts: GenerateOpts
): Promise<string[]> {
  const tmpFile = join(tmpdir(), `guff-gen-${Date.now()}.ts`);
  try {
    await Bun.write(tmpFile, code);

    if (opts.debug) {
      console.log(`--- Generated code written to ${tmpFile} ---`);
      console.log(code);
      console.log("--- Executing... ---");
    }

    const proc = Bun.spawnSync(["bun", "run", tmpFile], {
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      console.error(`Error: generated code failed (exit ${proc.exitCode}):`);
      console.error(stderr);
      process.exit(1);
    }

    const stdout = proc.stdout.toString().trim();
    let svgs: string[];
    try {
      svgs = JSON.parse(stdout);
    } catch {
      console.error("Error: generated code did not output valid JSON");
      if (opts.debug) console.error("stdout:", stdout.slice(0, 500));
      process.exit(1);
    }

    if (!Array.isArray(svgs) || svgs.length === 0) {
      console.error(`Error: expected array of SVG strings, got ${typeof svgs}`);
      process.exit(1);
    }

    if (svgs.length !== opts.numFrames) {
      console.log(
        `Warning: got ${svgs.length} frames (expected ${opts.numFrames})`
      );
    }

    for (let i = 0; i < svgs.length; i++) {
      if (typeof svgs[i] !== "string" || !svgs[i]!.trim().startsWith("<svg")) {
        console.error(`Error: frame ${i} is not a valid SVG string`);
        process.exit(1);
      }
    }

    return svgs;
  } finally {
    if (!opts.debug) {
      try {
        rmSync(tmpFile);
      } catch {}
    }
  }
}

// --- Provider implementations ---

async function generateClaude(opts: GenerateOpts): Promise<Buffer[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  const systemPrompt = `You are an animation frame generator. You write TypeScript code that produces SVG strings for animation frames.

OUTPUT FORMAT:
Write a self-contained TypeScript script that:
1. Creates exactly ${opts.numFrames} SVG strings, each ${opts.outputW}x${opts.outputH} pixels
2. Outputs a JSON array of SVG strings to stdout via console.log(JSON.stringify(svgs))
3. Uses ONLY built-in JavaScript/TypeScript — no imports, no require, no dependencies
4. Each SVG must be a complete, valid SVG document starting with <svg> and ending with </svg>

SVG GUIDELINES:
- Use viewBox="0 0 ${opts.outputW} ${opts.outputH}" on each SVG
- Use basic SVG elements: <rect>, <circle>, <ellipse>, <polygon>, <path>, <line>, <text>, <g>
- Use transform attributes for rotation, scaling, translation
- Use math (Math.sin, Math.cos, Math.PI) for smooth animation curves
- Use vibrant, complementary colors — avoid plain black-on-white
- Make subjects large, filling most of the frame
- Keep the subject centered and consistently sized across frames

ANIMATION PRINCIPLES:
- The animation should loop seamlessly (last frame flows back to first)
- Use easing: ease-in-out via sine curves, not linear interpolation
- For N frames, compute progress as t = i / N (not N-1, since it loops)
- Common patterns:
  - Oscillation: Math.sin(t * 2 * Math.PI)
  - Rotation: angle = t * 360
  - Bounce: Math.abs(Math.sin(t * Math.PI))
  - Pulse: 1 + 0.2 * Math.sin(t * 2 * Math.PI)

QUALITY:
- Add visual depth: gradients, shadows, layered shapes
- Use stroke-width >= 2 for outlines
- Add details: highlights, secondary motion, particle effects
- Make it visually polished, not basic placeholder graphics

CODE STRUCTURE TEMPLATE:
const frames: string[] = [];
const W = ${opts.outputW};
const H = ${opts.outputH};
const N = ${opts.numFrames};

for (let i = 0; i < N; i++) {
  const t = i / N; // 0 to 1, looping
  // ... build SVG string with template literals ...
  frames.push(svg);
}

console.log(JSON.stringify(frames));`;

  const userContent: any[] = [];
  for (const img of opts.inputImages) {
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data },
    });
  }
  userContent.push({
    type: "text",
    text: `Create a ${opts.numFrames}-frame looping animation of: ${opts.prompt}`,
  });

  const body = {
    model: opts.model,
    max_tokens: 4096,
    temperature: opts.temperature,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  };

  if (opts.debug) {
    console.log("--- Claude API Request ---");
    console.log(JSON.stringify({ ...body, system: "(see above)" }, null, 2));
    console.log("--- System Prompt ---");
    console.log(systemPrompt);
    console.log("-------------------");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Error: Claude API returned ${res.status}: ${err}`);
    process.exit(1);
  }

  const data: any = await res.json();

  // Log token usage
  const usage = data.usage;
  if (usage) {
    console.log(
      `Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`
    );
  }

  const textBlock = data.content?.find((b: any) => b.type === "text");
  if (!textBlock?.text) {
    console.error("Error: no text in Claude API response");
    if (opts.debug) console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const code = extractCode(textBlock.text);
  if (!code) {
    console.error("Error: could not extract code from Claude's response");
    if (opts.debug) console.error(textBlock.text.slice(0, 1000));
    process.exit(1);
  }

  const svgs = await executeFrameScript(code, opts);

  // Convert SVGs to PNGs
  const frames: Buffer[] = [];
  for (const svg of svgs) {
    const png = await sharp(Buffer.from(svg))
      .resize(opts.outputW, opts.outputH, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer();
    frames.push(png);
  }

  return frames;
}

async function generateGemini(opts: GenerateOpts): Promise<Buffer[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is required");
    process.exit(1);
  }

  // Build grid prompt
  const fullPrompt = [
    `Generate a ${opts.cols}x${opts.rows} grid of ${opts.numFrames} animation frames showing: ${opts.prompt}`,
    ``,
    `CRITICAL INSTRUCTIONS:`,
    `- Create exactly ${opts.numFrames} frames arranged in a ${opts.cols}-column, ${opts.rows}-row grid`,
    `- Frame order: left-to-right, top-to-bottom (frame 1 is top-left)`,
    `- Each frame shows the next step in a smooth, looping animation`,
    `- Use a plain white background in all frames`,
    `- All frames must be exactly the same size with clear, straight boundaries between them`,
    `- Do NOT draw borders, lines, or dividers between frames`,
    `- The animation should loop seamlessly from the last frame back to the first`,
    `- The subject should fill most of each frame with minimal padding — avoid large empty margins`,
    `- Keep the subject centered and consistently sized across all frames`,
    `- ABSOLUTELY NO text of any kind in the image: no frame numbers, no labels, no captions, no watermarks, no annotations`,
  ].join("\n");

  if (opts.debug) {
    console.log("--- Prompt ---");
    console.log(fullPrompt);
    console.log(
      `--- Grid: ${opts.cols}x${opts.rows}, Aspect ratio: ${opts.aspectRatio} ---`
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${apiKey}`;

  const parts: any[] = opts.inputImages.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  parts.push({ text: fullPrompt });

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

  // Log token usage
  const usage = data.usageMetadata;
  if (usage) {
    console.log(
      `Tokens: ${usage.promptTokenCount} in / ${usage.candidatesTokenCount} out`
    );
  }

  const candidate = data.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (p: any) => p.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    console.error("Error: no image data in API response");
    if (opts.debug) console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");

  // In debug mode, save the raw unsliced image
  if (opts.debug) {
    const debugPath = resolve("debug-unsliced.png");
    await sharp(imageBuffer).png().toFile(debugPath);
    console.log(`--- Saved unsliced image: ${debugPath} ---`);
  }

  // Split generated image into frames
  const metadata = await sharp(imageBuffer).metadata();
  const imgW = metadata.width!;
  const imgH = metadata.height!;

  const expectedFrameW = imgW / opts.cols;
  const expectedFrameH = expectedFrameW / opts.frameAR;
  const detectedRows = Math.round(imgH / expectedFrameH);
  let actualRows = opts.rows;
  if (detectedRows !== opts.rows) {
    console.log(
      `Warning: detected ${detectedRows} rows (expected ${opts.rows}), adjusting`
    );
    actualRows = detectedRows;
  }

  const frameW = Math.floor(imgW / opts.cols);
  const frameH = Math.floor(imgH / actualRows);

  if (opts.debug) {
    console.log(
      `--- Image: ${imgW}x${imgH}, Frame: ${frameW}x${frameH}, Grid: ${opts.cols}x${actualRows} ---`
    );
  }

  // Extract raw frames with 3% inset to crop grid borders
  const insetX = Math.max(1, Math.round(frameW * 0.03));
  const insetY = Math.max(1, Math.round(frameH * 0.03));

  const frames: Buffer[] = [];
  for (
    let row = 0;
    row < actualRows && frames.length < opts.numFrames;
    row++
  ) {
    for (
      let col = 0;
      col < opts.cols && frames.length < opts.numFrames;
      col++
    ) {
      const frame = await sharp(imageBuffer)
        .extract({
          left: col * frameW + insetX,
          top: row * frameH + insetY,
          width: frameW - insetX * 2,
          height: frameH - insetY * 2,
        })
        .resize(opts.outputW, opts.outputH, { fit: "cover" })
        .toBuffer();
      frames.push(frame);
    }
  }

  return frames;
}
