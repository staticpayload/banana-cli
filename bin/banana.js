#!/usr/bin/env node

import { runCli } from "../src/index.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}
