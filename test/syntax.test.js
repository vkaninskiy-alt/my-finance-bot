"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

for (const file of ["index.js", "config.js"]) {
  test(`${file} passes Node.js syntax check`, () => {
    const result = spawnSync(process.execPath, ["--check", path.join(__dirname, "..", file)], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
