#!/usr/bin/env node

"use strict";

const { run } = require("../src/index.js");

run().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
