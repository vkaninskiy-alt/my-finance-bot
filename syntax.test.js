"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { parseAmount, quickExpenseParts } = require("./expense-utils");

for (const file of ["index.js", "config.js", "expense-utils.js"]) {
  test(`${file} passes Node.js syntax check`, () => {
    const result = spawnSync(process.execPath, ["--check", path.join(__dirname, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

test("parseAmount accepts comma decimals and rejects malformed values", () => {
  assert.equal(parseAmount("12,50"), 12.5);
  assert.equal(parseAmount("120"), 120);
  assert.equal(parseAmount("11.3.3"), null);
  assert.equal(parseAmount("0"), null);
  assert.equal(parseAmount("-5"), null);
});

test("quick input extracts amount, description, and category", () => {
  const categories = [{ id: "supermarket", label: "Супермаркеты" }, { id: "cafe", label: "Кафе" }, { id: "other", label: "Другое" }];
  const result = quickExpenseParts("24,50 продукты хлеб", categories);
  assert.equal(result.amount, 24.5);
  assert.equal(result.description, "продукты хлеб");
  assert.equal(result.category.id, "supermarket");
  assert.equal(quickExpenseParts("не расход", categories), null);
});
