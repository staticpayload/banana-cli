import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  dedupeMediaSources,
  detectImageMime,
  envMediaSources,
  extractMediaFromPrompt,
  planOutputPaths,
  replyMediaPath,
  resolveModel,
  runCli,
  sanitizeFilename
} from "../src/index.js";

const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z5WQAAAAASUVORK5CYII=";
const PNG_1X1_BUFFER = Buffer.from(PNG_1X1_BASE64, "base64");

function createCaptureStream(isTTY = false) {
  let buffer = "";

  return {
    isTTY,
    write(chunk) {
      buffer += String(chunk);
      return true;
    },
    toString() {
      return buffer;
    }
  };
}

function createStubStdin() {
  return {
    isTTY: true,
    async *[Symbol.asyncIterator]() {}
  };
}

function createGenerateContentResponse(images = [PNG_1X1_BASE64]) {
  return {
    candidates: [
      {
        content: {
          parts: images.map((data) => ({
            inlineData: {
              mimeType: "image/png",
              data
            }
          }))
        }
      }
    ]
  };
}

test("resolveModel maps required aliases", () => {
  assert.equal(resolveModel("nano-banana-2"), "gemini-3.1-flash-image-preview");
  assert.equal(resolveModel("nano-banana-pro"), "nano-banana-pro-preview");
  assert.equal(resolveModel("google/gemini-3.1-flash-image-preview"), "gemini-3.1-flash-image-preview");
  assert.equal(resolveModel("google/nano-banana-pro-preview"), "nano-banana-pro-preview");
  assert.equal(resolveModel("gemini-3.1-pro-preview"), "gemini-3.1-pro-preview");
});

test("sanitizeFilename creates stable prompt slugs", () => {
  assert.equal(sanitizeFilename("A neon fox in rainy Tokyo at night"), "a-neon-fox-in-rainy-toky");
  assert.equal(sanitizeFilename(""), "image");
});

test("extractMediaFromPrompt removes MEDIA lines and placeholders", () => {
  const result = extractMediaFromPrompt(`MEDIA:/tmp/cat.png
make <media:image> this cyberpunk`);
  assert.equal(result.prompt, "make this cyberpunk");
  assert.deepEqual(result.media, ["/tmp/cat.png"]);
});

test("envMediaSources resolves env keys and OPENCLAW_CONTEXT payloads", () => {
  const media = envMediaSources({
    MEDIA_PATH: "/tmp/one.png",
    MEDIA_URL: "https://example.com/two.jpg",
    OPENCLAW_CONTEXT: JSON.stringify({
      mediaItems: [{ path: "/tmp/three.jpg" }, { url: "https://example.com/four.webp" }],
      attachments: { images: ["/tmp/five.gif"] }
    })
  });

  assert.deepEqual(media, [
    "/tmp/one.png",
    "https://example.com/two.jpg",
    "/tmp/five.gif",
    "/tmp/three.jpg",
    "https://example.com/four.webp"
  ]);
});

test("dedupeMediaSources keeps first occurrence only", () => {
  assert.deepEqual(dedupeMediaSources(["/tmp/a.png", "`/tmp/a.png`", "/tmp/b.png"]), ["/tmp/a.png", "/tmp/b.png"]);
});

test("detectImageMime validates supported image signatures", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectImageMime(png, { pathHint: "x.png" }), "image/png");
  assert.throws(() => detectImageMime(Buffer.from("not-an-image"), { pathHint: "x.png" }), /signature does not match|Unsupported/);
});

test("planOutputPaths creates unique default names for multiple images", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "banana-cli-"));
  await fs.writeFile(path.join(tempDir, "banana-test_1.png"), "existing");

  const images = [{ mime: "image/png" }, { mime: "image/png" }];
  const outputPaths = await planOutputPaths(images, "Banana Test", "", tempDir);

  assert.equal(path.basename(outputPaths[0]), "banana-test_1-1.png");
  assert.equal(path.basename(outputPaths[1]), "banana-test_2.png");
});

test("planOutputPaths treats existing directories as output roots", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "banana-cli-"));
  const outDir = path.join(tempDir, "renders");
  await fs.mkdir(outDir, { recursive: true });

  const images = [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }];
  const outputPaths = await planOutputPaths(images, "Banana Split", outDir, tempDir);

  assert.equal(path.dirname(outputPaths[0]), outDir);
  assert.equal(path.basename(outputPaths[0]), "banana-split_1.png");
  assert.equal(path.basename(outputPaths[1]), "banana-split_2.jpg");
});

test("replyMediaPath stays relative inside cwd and absolute outside cwd", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "banana-cli-cwd-"));
  const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "banana-cli-other-"));
  const inside = path.join(cwd, "inside.png");
  const outside = path.join(otherDir, "outside.png");

  await fs.writeFile(inside, PNG_1X1_BUFFER);
  await fs.writeFile(outside, PNG_1X1_BUFFER);

  assert.equal(await replyMediaPath(inside, cwd), "./inside.png");
  assert.equal(await replyMediaPath(outside, cwd), outside);
});

test("runCli uses relative media paths, default edit prompt, and plain MEDIA output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "banana-cli-run-"));
  await fs.writeFile(path.join(cwd, "source.png"), PNG_1X1_BUFFER);

  const stdout = createCaptureStream();
  const stderr = createCaptureStream();
  let capturedRequest;

  const exitCode = await runCli(["--media", "source.png"], {
    cwd,
    env: { GEMINI_API_KEY: "test-key" },
    stdin: createStubStdin(),
    stdout,
    stderr,
    fetchImpl: async (_url, options) => {
      capturedRequest = JSON.parse(options.body);

      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify(createGenerateContentResponse())
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");

  assert.equal(capturedRequest.contents[0].parts[1].text, "Create a derivative image based on the attached media.");
  assert.equal(capturedRequest.contents[0].parts[0].inlineData.mimeType, "image/png");

  const mediaLine = stdout
    .toString()
    .trim()
    .split("\n")
    .find((line) => line.startsWith("MEDIA:"));

  assert.ok(mediaLine);
  assert.match(mediaLine, /^MEDIA:\.\//u);

  const generatedFile = path.resolve(cwd, mediaLine.slice("MEDIA:".length));
  const stats = await fs.stat(generatedFile);
  assert.ok(stats.isFile());
  assert.ok(stats.size > 0);
});

test("runCli honors quiet over verbose", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "banana-cli-quiet-"));
  await fs.writeFile(path.join(cwd, "source.png"), PNG_1X1_BUFFER);

  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli(["--media", "source.png", "--verbose", "--quiet"], {
    cwd,
    env: { GEMINI_API_KEY: "test-key" },
    stdin: createStubStdin(),
    stdout,
    stderr,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify(createGenerateContentResponse())
    })
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /^MEDIA:/u);
});

test("runCli returns usage error when no prompt or media is provided", async () => {
  const stdout = createCaptureStream();
  const stderr = createCaptureStream();

  const exitCode = await runCli([], {
    env: {},
    stdin: createStubStdin(),
    stdout,
    stderr
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Missing prompt/u);
});
