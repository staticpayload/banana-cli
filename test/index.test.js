"use strict";

const assert = require("node:assert");
const { __internal } = require("../src/index.js");

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

console.log("banana-cli: internal helper tests");

const origEnv = { ...process.env };

test("resolve model aliases", () => {
  assert.strictEqual(__internal.resolveModel("nano-banana-2"), "gemini-3.1-flash-image-preview");
  assert.strictEqual(__internal.resolveModel("NANO-BANANA-PRO"), "nano-banana-pro-preview");
  assert.strictEqual(__internal.resolveModel("custom-model"), "custom-model");
});

test("parse prompt + media marker", () => {
  const { prompt, media } = __internal.parsePromptAndMedia(
    "Make this blue car red\nMEDIA_PATHS: /tmp/a.jpg ; /tmp/b.png\n<media:ignore>"
  );
  assert.ok(prompt.includes("Make this blue car red"));
  assert.strictEqual(media.length, 2);
  assert.strictEqual(media[0], "/tmp/a.jpg");
  assert.strictEqual(media[1], "/tmp/b.png");
});

test("parse CSV/JSON-like media hints", () => {
  const got = __internal.parseCsvish("a,b,c");
  assert.deepStrictEqual(got, ["a", "b", "c"]);
});

test("output paths defaults", () => {
  const out = __internal.toOutputPaths("my prompt", [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }], "");
  assert.strictEqual(out.length, 2);
  assert.ok(/my-prompt_1\.png$/.test(out[0]));
  assert.ok(/my-prompt_2\.jpg$/.test(out[1]));
});

test("env media includes env var and context", () => {
  process.env.MediaPath = "/from-env.jpg";
  process.env.OPENCLAW_CONTEXT = JSON.stringify({ mediaPathUrl: "/from-context.json" });
  const media = __internal.envMediaSources();
  assert.ok(media.includes("/from-env.jpg"));
  assert.ok(media.includes("/from-context.json"));
});

// cleanup env
delete process.env.MediaPath;
delete process.env.OPENCLAW_CONTEXT;
for (const key of Object.keys(process.env)) {
  if (!(key in origEnv)) {
    delete process.env[key];
  } else if (origEnv[key] === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = origEnv[key];
  }
}
