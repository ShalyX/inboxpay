import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function countFunctions(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countFunctions(target);
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) count += 1;
  }
  return count;
}

const count = await countFunctions(path.resolve("api"));
assert.ok(count <= 12, `Vercel Hobby permits at most 12 serverless functions; api/ currently has ${count}`);
console.log(`Vercel function budget passed (${count}/12)`);
