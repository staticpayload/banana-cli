#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { URL } = require("node:url");

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const MODEL_ALIASES = {
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

const MEDIA_LINE_RE = /^\s*MEDIA(?:_PATHS?|_URLS?)?:\s*(.+?)\s*$/i;
const MEDIA_TOKEN_RE = /<media:[^>]+>/gi;

function resolveModel(model) {
  if (!model) {
    return model;
  }
  return MODEL_ALIASES[model.trim().toLowerCase()] || model.trim();
}

function parseCsvish(value) {
  if (!value) {
    return [];
  }

  const s = String(value).trim();
  if (!s) {
    return [];
  }

  if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (_err) {
      // fallthrough
    }
  }

  if (s.includes(";")) {
    return s.split(";").map((x) => x.trim()).filter(Boolean);
  }
  if (s.includes("\n")) {
    return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  if (s.includes(",")) {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }

  return [s];
}

function sanitizeFileName(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "image";
}

function parsePromptAndMedia(inputPrompt) {
  const media = [];
  const lines = [];

  const promptText = inputPrompt || "";
  for (const line of promptText.split(/\r?\n/)) {
    const lineMatch = line.match(MEDIA_LINE_RE);
    if (lineMatch) {
      parseCsvish(lineMatch[1]).forEach((value) => {
        if (value) {
          media.push(value.trim().replace(/^`|`$/g, ""));
        }
      });
      continue;
    }

    const cleaned = line.replace(MEDIA_TOKEN_RE, "").trim();
    if (cleaned) {
      lines.push(cleaned);
    }
  }

  return {
    prompt: lines.join(" ").trim(),
    media
  };
}

function collectMediaFromValue(out, value) {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    parseCsvish(value).forEach((item) => {
      const clean = String(item).trim().replace(/^`|`$/g, "");
      if (clean) {
        out.push(clean);
      }
    });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaFromValue(out, item);
    }
    return;
  }

  if (typeof value === "object") {
    const keys = [
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
      "mediaItems",
      "files",
      "attachments",
      "attachment",
      "image",
      "images",
      "source"
    ];

    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(String(key).toLowerCase())) {
        collectMediaFromValue(out, child);
      }
    }

    if (value.media !== undefined) {
      collectMediaFromValue(out, value.media);
    }

    const nestedPaths =
      value.mediaPath ||
      value.MediaPath ||
      value.mediaPaths ||
      value.MediaPaths ||
      value.mediaUrl ||
      value.MediaUrl ||
      value.mediaUrls ||
      value.MediaUrls;
    if (nestedPaths !== undefined) {
      collectMediaFromValue(out, nestedPaths);
    }
  }
}

function envMediaSources() {
  const out = [];
  const keys = [
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

  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      collectMediaFromValue(out, value);
    }
  }

  const context = process.env.OPENCLAW_CONTEXT;
  if (context) {
    try {
      const parsed = JSON.parse(context);
      if (parsed && typeof parsed === "object") {
        for (const key of keys) {
          if (parsed[key]) {
            collectMediaFromValue(out, parsed[key]);
          }
        }
        collectMediaFromValue(out, parsed);
      }
    } catch (_err) {
      // ignore malformed JSON context
    }
  }

  const seen = new Set();
  return out.filter((item) => {
    if (!item || seen.has(item)) {
      return false;
    }
    seen.add(item);
    return true;
  });
}

function isHttpUrl(source) {
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

function detectImageType(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) {
    return null;
  }

  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: ".png" };
  }

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }

  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { mimeType: "image/gif", extension: ".gif" };
  }

  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: ".webp" };
  }

  return null;
}

function validateImageBuffer(data, label) {
  const detected = detectImageType(data);
  if (!detected) {
    throw new Error(`Invalid or unsupported image data${label ? ` for ${label}` : ""}`);
  }
  return detected;
}

async function loadMedia(source) {
  const cleanSource = String(source).trim().replace(/^`|`$/g, "");
  if (!cleanSource) {
    throw new Error("Empty media source");
  }

  let data;

  if (isHttpUrl(cleanSource)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(cleanSource, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch media: ${response.status} ${response.statusText}`);
      }
      data = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  } else {
    const fullPath = path.resolve(cleanSource);
    data = await fs.promises.readFile(fullPath);
  }

  const detected = validateImageBuffer(data, cleanSource);
  return {
    data: data.toString("base64"),
    mimeType: detected.mimeType
  };
}

function toOutputPaths(basePrompt, images, outputFlag) {
  const result = [];

  const chooseSuffix = (mime) => {
    const map = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif"
    };

    return map[mime] || ".png";
  };

  const ensureParent = (p) => {
    const parent = path.dirname(p);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    return p;
  };

  if (outputFlag) {
    const requested = path.resolve(outputFlag);
    const parsed = path.parse(requested);
    const stem = parsed.name.trim() || "image";
    const directory = parsed.dir || process.cwd();

    if (images.length === 1) {
      const suffix = chooseSuffix(images[0].mimeType);
      result.push(ensureParent(path.resolve(directory, `${stem}${suffix}`)));
      return result;
    }

    for (let i = 0; i < images.length; i += 1) {
      const suffix = chooseSuffix(images[i].mimeType);
      const fileName = `${stem}_${i + 1}${suffix}`;
      result.push(ensureParent(path.resolve(directory, fileName)));
    }
    return result;
  }

  const stem = sanitizeFileName(basePrompt);
  for (let i = 0; i < images.length; i += 1) {
    const suffix = chooseSuffix(images[i].mimeType);
    const fileName = images.length > 1 ? `${stem}_${i + 1}${suffix}` : `${stem}${suffix}`;
    result.push(path.resolve(process.cwd(), fileName));
  }

  return result;
}

function extractTextParts(parsed) {
  const lines = [];

  if (Array.isArray(parsed?.candidates)) {
    for (const candidate of parsed.candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text.trim()) {
          lines.push(part.text.trim());
        }
      }
    }
  }

  return Array.from(new Set(lines));
}

async function extractPrompt(args) {
  const positional = (args._ || []).join(" ").trim();
  const explicitPrompt = args.prompt;

  let prompt = explicitPrompt || positional;

  const stdinText =
    args.prompt === "-" || (positional === "" && !explicitPrompt && !process.stdin.isTTY);

  if (prompt === "-" || stdinText) {
    prompt = await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data.trim()));
      process.stdin.on("error", reject);
      if (process.stdin.isTTY === false) {
        process.stdin.resume();
      }
    });
  }

  const cleaned = parsePromptAndMedia(prompt || "");
  let finalPrompt = cleaned.prompt || prompt || "";

  if (!finalPrompt && !args.media?.length && !cleaned.media.length && !envMediaSources().length) {
    finalPrompt = "";
  }

  return {
    prompt: finalPrompt,
    inlineMedia: cleaned.media
  };
}

async function run() {
  const argv = yargs(hideBin(process.argv))
    .scriptName("banana")
    .usage("$0 [options] [prompt]")
    .option("prompt", {
      alias: "p",
      type: "string",
      describe: "Prompt text (or use '-' to read stdin)"
    })
    .option("media", {
      alias: "m",
      type: "string",
      array: true,
      describe: "Reference image path or URL (repeatable)"
    })
    .option("model", {
      type: "string",
      default: "nano-banana-pro",
      describe: "Model alias/name"
    })
    .option("count", {
      type: "number",
      default: 1,
      describe: "Images to request (1-4)"
    })
    .option("out", {
      type: "string",
      describe: "Output path (optional)"
    })
    .option("json", {
      type: "string",
      describe: "Write full API response JSON to this path"
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Print request details to stderr"
    })
    .help()
    .strict()
    .parse();

  const { prompt, inlineMedia } = await extractPrompt(argv);

  let mediaSources = [];
  if (argv.media) {
    mediaSources.push(...argv.media);
  }
  mediaSources.push(...inlineMedia);
  mediaSources.push(...envMediaSources());

  mediaSources = Array.from(new Set(mediaSources.map((item) => String(item).trim()).filter(Boolean)));

  const effectivePrompt = (prompt || "").trim();
  const effectiveCount = Number.isFinite(argv.count) ? Math.max(1, Math.min(4, argv.count)) : 1;

  if (!effectivePrompt && !mediaSources.length) {
    throw new Error("Provide a prompt, --prompt, stdin input, or --media reference image.");
  }

  const fallbackPrompt = effectivePrompt
    ? effectivePrompt
    : "Create a derivative image based on the attached media.";

  const parts = [];

  if (mediaSources.length) {
    const mediaPayload = await loadMedia(mediaSources[0]);
    parts.push({ inlineData: mediaPayload });
  }
  parts.push({ text: fallbackPrompt });

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
      candidateCount: effectiveCount
    }
  };

  const model = resolveModel(argv.model);
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY)");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${responseText}`);
  }

  const parsed = JSON.parse(responseText);
  if (argv.json) {
    const jsonPath = path.resolve(argv.json);
    await fs.promises.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.promises.writeFile(jsonPath, JSON.stringify(parsed, null, 2), "utf8");
  }

  const textLines = extractTextParts(parsed);
  const images = [];
  if (Array.isArray(parsed?.candidates)) {
    for (const candidate of parsed.candidates) {
      const candidateParts = candidate?.content?.parts || [];
      for (const part of candidateParts) {
        if (part?.inlineData?.data) {
          const raw = Buffer.from(part.inlineData.data, "base64");
          const detected = validateImageBuffer(raw, "Gemini response");
          images.push({
            data: part.inlineData.data,
            mimeType: detected.mimeType
          });
        }
      }
    }
  }

  if (!images.length && Array.isArray(parsed?.generatedImages)) {
    for (const generated of parsed.generatedImages) {
      if (generated?.inlineData?.data) {
        const raw = Buffer.from(generated.inlineData.data, "base64");
        const detected = validateImageBuffer(raw, "Gemini response");
        images.push({
          data: generated.inlineData.data,
          mimeType: detected.mimeType
        });
      }
    }
  }

  if (!images.length) {
    throw new Error(`No image data returned by model. Response:\n${JSON.stringify(parsed, null, 2)}`);
  }

  const targetPaths = toOutputPaths(fallbackPrompt, images, argv.out || "");

  if (argv.verbose) {
    console.error(`Model: ${model}`);
    console.error(`Prompt: ${fallbackPrompt}`);
    console.error(`Count: ${images.length}`);
    console.error(`Output: ${argv.out || "./<auto>"}`);
  }

  for (const line of textLines) {
    console.log(line);
  }

  for (let i = 0; i < images.length; i += 1) {
    const outputPath = targetPaths[i];
    const image = images[i];
    const raw = Buffer.from(image.data, "base64");
    validateImageBuffer(raw, outputPath);

    await fs.promises.writeFile(outputPath, raw);

    const stats = await fs.promises.stat(outputPath);
    if (!stats || !stats.size) {
      throw new Error(`Failed to write generated image: ${outputPath}`);
    }

    console.log(`MEDIA:${outputPath}`);
  }
}

module.exports = {
  run,
  __internal: {
    sanitizeFileName,
    parseCsvish,
    parsePromptAndMedia,
    toOutputPaths,
    resolveModel,
    envMediaSources,
    detectImageType,
    validateImageBuffer
  }
};
