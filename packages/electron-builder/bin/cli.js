#!/usr/bin/env node
"use strict";

const { runCli } = require("../lib/cli");

runCli().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`minitron-builder: ${message}`);
  process.exitCode = 1;
});
