import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import yargs from "yargs/yargs";

export const MODEL_ALIASES = {
  "nano-banana-2": "gemini-3.1-flash-image-preview",
  "nano-banana-pro": "nano-banana-pro-preview",
  "gemini-3-flash-image-preview": "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
  "google/gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
  "nano-banana-pro-preview": "nano-banana-pro-preview",
  "gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "google/gemini-3-pro-image-preview": "nano-banana-pro-preview",
  "google/nano-banana-pro-preview": "nano-banana-pro-preview"
};

export const MEDIA_LINE_RE = /^\s*MEDIA(?:_PATHS?|_URLS?)?:\s*(.+?)\s*$/i;
export const MEDIA_TOKEN_RE = /<media:[^>]+>/gi;

const IMAGE_EXTENSION_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
const IMAGE_MIMES = new Set(Object.keys(IMAGE_EXTENSION_BY_MIME));
const DEFAULT_EDIT_PROMPT = "Create a derivative image based on the attached media.";
const STDIN_SENTINEL = "__BANANA_STDIN__";
const ANSI = {
  reset: "\u001b[0m",
  red: "\u001b[31m",
  yellow: "\u001b[33m"
};
const OPENCLAW_ENV_KEYS = [
  "MediaPath",
  "mediaPath",
  "MediaPaths",
  "mediaPaths",
  "MediaUrl",
  "mediaUrl",
  "MediaUrls",
  "mediaUrls",
  "MEDIA_PATH",
  "MEDIA_PATHS",
  "MEDIA_URL",
  "MEDIA_URLS",
  "OPENCLAW_MEDIA",
  "OPENCLAW_MEDIA_PATH",
  "OPENCLAW_MEDIA_PATHS",
  "OPENCLAW_MEDIA_URL",
  "OPENCLAW_MEDIA_URLS",
  "MEDIA",
  "media",
  "mediaPathUrl",
  "MediaPathUrl"
];
const MEDIA_CONTEXT_KEYS = new Set([
  "mediapath",
  "mediapaths",
  "mediaurl",
  "mediaurls",
  "media_path",
  "media_paths",
  "media_url",
  "media_urls",
  "path",
  "paths",
  "url",
  "urls",
  "media",
  "mediaitems",
  "files",
  "attachments",
  "attachment",
  "image",
  "images",
  "source"
]);
const OPENCLAW_CONTEXT_KEYS = [
  "MediaPath",
  "mediaPath",
  "MediaPaths",
  "mediaPaths",
  "MediaUrl",
  "mediaUrl",
  "MediaUrls",
  "mediaUrls",
  "MEDIA_PATH",
  "MEDIA_PATHS",
  "MEDIA_URL",
  "MEDIA_URLS",
  "media",
  "Media",
  "attachments",
  "mediaItems"
];

function supportsColor(stream, env = process.env) {
  return Boolean(stream?.isTTY) && !env.NO_COLOR;
}

function colorize(text, color, stream, env) {
  if (!supportsColor(stream, env)) {
    return text;
  }

  return `${color}${text}${ANSI.reset}`;
}

function formatError(message, stderr, env, quiet = false) {
  const text = String(message || "Unknown error");
  if (quiet || !supportsColor(stderr, env)) {
    return text;
  }

  return `${colorize("Error:", ANSI.red, stderr, env)} ${text}`;
}

function writeVerbose(stderr, env, quiet, message) {
  if (quiet) {
    return;
  }

  stderr.write(`${colorize("banana:", ANSI.yellow, stderr, env)} ${message}\n`);
}

export function resolveModel(model) {
  const normalized = String(model || "").trim();
  return MODEL_ALIASES[normalized.toLowerCase()] || normalized;
}

export function sanitizeFilename(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  return (normalized || "image").slice(0, 24);
}

export function splitCsvish(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }

  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      // Fall through to best-effort splitting.
    }
  }

  if (text.includes(";")) {
    return text.split(";").map((item) => item.trim()).filter(Boolean);
  }
  if (text.includes("\n")) {
    return text.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  }
  if (text.includes(",")) {
    return text.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return [text];
}

export function extractMediaFromPrompt(promptText) {
  const prompt = String(promptText || "");
  const media = [];
  const lines = [];

  for (const line of prompt.split(/\r?\n/u)) {
    const match = line.match(MEDIA_LINE_RE);
    if (match) {
      const raw = match[1]?.trim().replace(/^`|`$/g, "");
      if (raw) {
        media.push(...splitCsvish(raw));
      }
      continue;
    }

    const cleaned = line.replace(MEDIA_TOKEN_RE, " ").replace(/\s+/g, " ").trim();
    if (cleaned) {
      lines.push(cleaned);
    }
  }

  return {
    prompt: lines.join(" ").trim(),
    media
  };
}

function extendMediaList(target, candidates) {
  for (const rawCandidate of candidates) {
    if (rawCandidate == null) {
      continue;
    }

    for (const value of splitCsvish(String(rawCandidate))) {
      const cleaned = value.trim().replace(/^`|`$/g, "");
      if (cleaned) {
        target.push(cleaned);
      }
    }
  }
}

function collectMediaFromContextValue(target, value) {
  if (value == null) {
    return;
  }

  if (typeof value === "string") {
    extendMediaList(target, [value]);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaFromContextValue(target, item);
    }
    return;
  }

  if (typeof value !== "object") {
    extendMediaList(target, [String(value)]);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (MEDIA_CONTEXT_KEYS.has(key.trim().toLowerCase())) {
      collectMediaFromContextValue(target, child);
    }
  }

  for (const key of [
    "media",
    "mediaPaths",
    "MediaPaths",
    "mediaPath",
    "MediaPath",
    "mediaUrls",
    "MediaUrls",
    "mediaUrl",
    "MediaUrl"
  ]) {
    if (value[key] != null) {
      collectMediaFromContextValue(target, value[key]);
    }
  }
}

export function envMediaSources(env = process.env) {
  const sources = [];

  for (const key of OPENCLAW_ENV_KEYS) {
    if (env[key]) {
      extendMediaList(sources, [env[key]]);
    }
  }

  if (env.OPENCLAW_CONTEXT) {
    try {
      const parsed = JSON.parse(env.OPENCLAW_CONTEXT);
      if (parsed && typeof parsed === "object") {
        for (const key of OPENCLAW_CONTEXT_KEYS) {
          if (parsed[key] != null) {
            collectMediaFromContextValue(sources, parsed[key]);
          }
        }

        collectMediaFromContextValue(sources, parsed);
      }
    } catch {
      const { media } = extractMediaFromPrompt(env.OPENCLAW_CONTEXT);
      extendMediaList(sources, media);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const source of sources) {
    if (!seen.has(source)) {
      seen.add(source);
      unique.push(source);
    }
  }

  return unique;
}

export function dedupeMediaSources(sources) {
  const seen = new Set();
  const unique = [];

  for (const source of sources) {
    const cleaned = String(source || "").trim().replace(/^`|`$/g, "");
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    unique.push(cleaned);
  }

  return unique;
}

function inferMimeFromPath(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return "";
}

function getImageMime(image) {
  return image?.mime || image?.mimeType || "";
}

export function detectImageMime(buffer, hints = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error("Image payload is empty or invalid.");
  }

  const { pathHint = "", contentTypeHint = "" } = hints;
  const contentType = String(contentTypeHint || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/")) {
    throw new Error(`Expected image media but received ${contentType}.`);
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const pathMime = inferMimeFromPath(pathHint);
  if (pathMime && IMAGE_MIMES.has(pathMime)) {
    throw new Error(`Image signature does not match file extension for ${pathHint}.`);
  }

  throw new Error("Unsupported or unrecognized image format. Supported formats: PNG, JPEG, WEBP, GIF.");
}

function decodeBase64Image(base64Data, expectedMime) {
  const buffer = Buffer.from(base64Data, "base64");
  const detectedMime = detectImageMime(buffer, { contentTypeHint: expectedMime });
  return { buffer, mime: detectedMime };
}

export async function loadMediaPayload(source, options = {}) {
  const cleaned = String(source || "").trim().replace(/^`|`$/g, "");
  if (!cleaned) {
    throw new Error("Empty media source.");
  }

  const { cwd = process.cwd() } = options;
  let buffer;
  let contentTypeHint = "";

  if (/^https?:\/\//iu.test(cleaned)) {
    const response = await (options.fetchImpl || fetch)(cleaned);
    if (!response.ok) {
      throw new Error(`Failed to fetch reference image: HTTP ${response.status}.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    contentTypeHint = response.headers.get("content-type") || "";
  } else {
    const resolvedPath = path.resolve(cwd, cleaned);
    try {
      buffer = await fs.readFile(resolvedPath);
    } catch {
      throw new Error(`Input image not found: ${resolvedPath}`);
    }
    contentTypeHint = inferMimeFromPath(resolvedPath);
  }

  const mimeType = detectImageMime(buffer, {
    pathHint: cleaned,
    contentTypeHint
  });

  return {
    mimeType,
    data: buffer.toString("base64")
  };
}

function extractInlineData(node) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const inlineData = node.inlineData || node.inline_data;
  if (!inlineData || typeof inlineData !== "object") {
    return null;
  }

  return {
    mimeType: inlineData.mimeType || inlineData.mime_type,
    data: inlineData.data
  };
}

export function extractImages(payload) {
  const images = [];
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inlineData = extractInlineData(part);
      if (inlineData?.data) {
        const { buffer, mime } = decodeBase64Image(inlineData.data, inlineData.mimeType);
        images.push({ buffer, mime });
      }
    }
  }

  const generatedImages = Array.isArray(payload?.generatedImages) ? payload.generatedImages : [];
  for (const imageNode of generatedImages) {
    const inlineData = extractInlineData(imageNode);
    if (inlineData?.data) {
      const { buffer, mime } = decodeBase64Image(inlineData.data, inlineData.mimeType);
      images.push({ buffer, mime });
    }
  }

  return images;
}

function getOutputExtension(mime) {
  return IMAGE_EXTENSION_BY_MIME[mime] || ".png";
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureUniquePath(filePath) {
  const parsed = path.parse(filePath);
  let candidate = filePath;
  let index = 1;

  while (await pathExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }

  return candidate;
}

async function isDirectoryTarget(targetPath) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

export async function planOutputPaths(images, prompt, outPath = "", cwd = process.cwd()) {
  const slug = sanitizeFilename(prompt);
  const planned = [];

  if (outPath) {
    const absoluteOut = path.resolve(cwd, outPath);
    const treatAsDirectory =
      outPath.endsWith(path.sep) ||
      outPath.endsWith("/") ||
      outPath.endsWith("\\") ||
      (await isDirectoryTarget(absoluteOut));
    const outDirectory = treatAsDirectory ? absoluteOut : path.dirname(absoluteOut);
    const providedBase = path.parse(absoluteOut);
    const baseName = treatAsDirectory ? slug : providedBase.name || slug;

    for (let index = 0; index < images.length; index += 1) {
      const suffix = getOutputExtension(getImageMime(images[index]));
      const stem = images.length === 1 ? baseName : `${baseName}_${index + 1}`;
      const candidate = path.join(outDirectory, `${stem}${suffix}`);
      planned.push(await ensureUniquePath(candidate));
    }

    return planned;
  }

  for (let index = 0; index < images.length; index += 1) {
    const suffix = getOutputExtension(getImageMime(images[index]));
    const stem = images.length === 1 ? slug : `${slug}_${index + 1}`;
    const candidate = path.join(cwd, `${stem}${suffix}`);
    planned.push(await ensureUniquePath(candidate));
  }

  return planned;
}

export async function writeImages(images, prompt, outPath = "", cwd = process.cwd()) {
  const outputPaths = await planOutputPaths(images, prompt, outPath, cwd);

  for (let index = 0; index < images.length; index += 1) {
    const filePath = outputPaths[index];
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, images[index].buffer);
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      throw new Error(`Generated file was not written correctly: ${filePath}`);
    }
  }

  return outputPaths;
}

export async function replyMediaPath(filePath, cwd = process.cwd()) {
  const absolutePath = path.resolve(filePath);
  const absoluteCwd = path.resolve(cwd);

  if (!(await pathExists(absolutePath))) {
    return filePath;
  }

  const relativePath = path.relative(absoluteCwd, absolutePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return `./${relativePath}`;
  }

  return absolutePath;
}

export const __internal = {
  resolveModel,
  sanitizeFilename,
  splitCsvish,
  extractMediaFromPrompt,
  envMediaSources,
  dedupeMediaSources,
  detectImageMime,
  planOutputPaths,
  replyMediaPath
};

export async function readPromptFromStdin(stdin = process.stdin) {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("").trim();
}

function createParser(argvInput, stdout = process.stdout) {
  return yargs(argvInput)
    .scriptName("banana")
    .usage("$0 [options] [prompt text]")
    .wrap(Math.min(stdout.columns || 96, 96))
    .example('$0 "text prompt"', "Generate an image from a text prompt.")
    .example("$0 --media /path/to/image.jpg \"edit this\"", "Edit from a reference image.")
    .example(
      "$0 --media /path/to/image.jpg --model nano-banana-2 --count 2 --out out.png --json response.json",
      "Generate multiple images and save the raw response."
    )
    .example("$0 -m /path/to/image.jpg -o ./renders/", "Write generated files into a directory.")
    .example("cat prompt.txt | $0 --prompt -", "Read the prompt from stdin.")
    .option("prompt", {
      alias: "p",
      type: "string",
      describe: "Prompt text. Use '-' to read the prompt from stdin."
    })
    .option("stdin", {
      type: "boolean",
      default: false,
      describe: "Read prompt text from stdin when no explicit prompt is provided."
    })
    .option("media", {
      alias: "m",
      type: "string",
      array: true,
      default: [],
      describe: "Reference image path or URL. Repeatable; only the first resolved media is used."
    })
    .option("model", {
      type: "string",
      default: "nano-banana-pro",
      describe: "Model alias or model id."
    })
    .option("count", {
      type: "number",
      default: 1,
      describe: "Number of images to request (1-4)."
    })
    .option("out", {
      alias: "o",
      type: "string",
      describe: "Output file path or directory. Multiple images append _1, _2, ... automatically."
    })
    .option("json", {
      type: "string",
      describe: "Optional path to save the raw JSON API response."
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print resolved model and media details to stderr."
    })
    .option("quiet", {
      alias: "q",
      type: "boolean",
      default: false,
      describe: "Suppress non-essential stderr output. Errors remain plain."
    })
    .group(["prompt", "stdin", "media"], "Input:")
    .group(["model", "count", "out", "json"], "Generation:")
    .group(["verbose", "quiet", "help", "version"], "Control:")
    .epilog("Successful runs print plain MEDIA:<path> lines to stdout. Diagnostics stay on stderr.")
    .strict()
    .check((argv) => {
      if (!Number.isInteger(argv.count) || argv.count < 1 || argv.count > 4) {
        throw new Error("--count must be an integer between 1 and 4.");
      }
      return true;
    })
    .help();
}

export async function getPrompt(argv, stdin = process.stdin) {
  if (argv.prompt === "-" || argv.prompt === STDIN_SENTINEL) {
    return readPromptFromStdin(stdin);
  }

  if (typeof argv.prompt === "string" && argv.prompt.trim()) {
    return argv.prompt.trim();
  }

  const positionalPrompt = argv._.map(String).join(" ").trim();
  if (positionalPrompt) {
    return positionalPrompt;
  }

  if (argv.stdin || stdin.isTTY === false) {
    return readPromptFromStdin(stdin);
  }

  return "";
}

export async function generateImages({
  prompt,
  mediaSources,
  model,
  count,
  jsonPath = "",
  outPath = "",
  verbose = false,
  quiet = false,
  env = process.env,
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd()
}) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY or GOOGLE_API_KEY.");
  }

  const resolvedModel = resolveModel(model || "nano-banana-pro");
  const parts = [];

  if (mediaSources.length > 0) {
    const mediaPayload = await loadMediaPayload(mediaSources[0], { fetchImpl, cwd });
    parts.push({ inlineData: mediaPayload });
  }

  parts.push({ text: prompt });

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
      candidateCount: count
    }
  };

  if (verbose && !quiet) {
    writeVerbose(stderr, env, quiet, `model=${resolvedModel}`);
    if (mediaSources[0]) {
      writeVerbose(stderr, env, quiet, `media=${mediaSources[0]}`);
    }
  }

  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload)
    }
  );

  const rawBody = await response.text();
  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    const message = parsedBody ? JSON.stringify(parsedBody) : rawBody;
    throw new Error(`Gemini request failed with HTTP ${response.status}: ${message}`);
  }

  if (!parsedBody) {
    throw new Error("Gemini returned a non-JSON response.");
  }

  if (jsonPath) {
    const absoluteJsonPath = path.resolve(cwd, jsonPath);
    await fs.mkdir(path.dirname(absoluteJsonPath), { recursive: true });
    await fs.writeFile(absoluteJsonPath, JSON.stringify(parsedBody, null, 2));
  }

  const images = extractImages(parsedBody);
  if (images.length === 0) {
    throw new Error("No image data returned from API.");
  }

  const writtenPaths = await writeImages(images, prompt, outPath, cwd);
  const mediaLines = [];

  for (const writtenPath of writtenPaths) {
    const mediaPath = await replyMediaPath(writtenPath, cwd);
    mediaLines.push(mediaPath);
    stdout.write(`MEDIA:${mediaPath}\n`);
  }

  return {
    model: resolvedModel,
    images: mediaLines,
    raw: parsedBody
  };
}

function normalizeArgv(argvInput) {
  const normalized = [...argvInput];

  for (let index = 0; index < normalized.length - 1; index += 1) {
    if ((normalized[index] === "--prompt" || normalized[index] === "-p") && normalized[index + 1] === "-") {
      normalized[index + 1] = STDIN_SENTINEL;
    }
  }

  return normalized;
}

export async function runCli(argvInput = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const stdin = io.stdin || process.stdin;
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  const fetchImpl = io.fetchImpl || fetch;

  let argv;
  try {
    argv = await createParser(normalizeArgv(argvInput), stdout).parse();
  } catch (error) {
    stderr.write(`${formatError(error?.message || error, stderr, env)}\n`);
    return 1;
  }

  let prompt = await getPrompt(argv, stdin);
  const extracted = extractMediaFromPrompt(prompt);
  prompt = extracted.prompt;

  const mediaSources = dedupeMediaSources([
    ...(argv.media || []),
    ...extracted.media,
    ...envMediaSources(env)
  ]);

  if (!prompt) {
    prompt = mediaSources.length > 0 ? DEFAULT_EDIT_PROMPT : "";
  }

  if (!prompt && mediaSources.length === 0) {
    stderr.write("Missing prompt. Provide text prompt, --prompt -, stdin, or use --media with a reference image.\n");
    stderr.write('Run "banana --help" for usage.\n');
    return 2;
  }

  try {
    await generateImages({
      prompt,
      mediaSources,
      model: argv.model,
      count: argv.count,
      jsonPath: argv.json || "",
      outPath: argv.out || "",
      verbose: argv.verbose,
      quiet: argv.quiet,
      env,
      fetchImpl,
      stdout,
      stderr,
      cwd
    });
    return 0;
  } catch (error) {
    stderr.write(`${formatError(error?.message || error, stderr, env, argv.quiet)}\n`);
    return 1;
  }
}
