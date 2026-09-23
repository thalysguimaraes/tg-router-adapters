import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSiblings, removeFanout, writeFanout } from "./fanout";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fanout-")); });
afterEach(() => { removeFanout(dir, "parent"); removeFanout(dir, "child"); });

const ASTRA = "openai-codex/gpt-6-astra";

test("writeFanout then readSiblings groups parent+other children, excluding the reader", () => {
  writeFanout(dir, "parent", ASTRA, { childA: ASTRA, childB: ASTRA });
  expect(readSiblings(dir, "childA", "parent")).toEqual([{ canonicalRef: ASTRA, count: 2 }]);
});

test("readSiblings with undefined parentId yields []", () => {
  expect(readSiblings(dir, "childA", undefined)).toEqual([]);
});

test("readSiblings with missing parent file yields []", () => {
  expect(readSiblings(dir, "childA", "missing")).toEqual([]);
});

test("readSiblings with corrupt parent JSON yields []", () => {
  writeFileSync(join(dir, "parent.json"), "{not json");
  expect(readSiblings(dir, "childA", "parent")).toEqual([]);
});

test("removeFanout deletes the file and a second call does not throw", () => {
  writeFanout(dir, "parent", ASTRA);
  removeFanout(dir, "parent");
  expect(() => readFileSync(join(dir, "parent.json"))).toThrow();
  expect(() => removeFanout(dir, "parent")).not.toThrow();
});
