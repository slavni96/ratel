import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// ADR-0001 numbers records sequentially, one number each. Two PRs written in parallel can
// both take "the next number" and both merge, which is how two 0020s landed three days
// apart. Nothing in review catches that reliably, so CI does.
const adrDir = new URL("../docs/adr/", import.meta.url);
const adrFiles = readdirSync(adrDir)
  .filter((name) => /^\d{4}-.+\.md$/.test(name))
  .sort();
const docsReadme = readFileSync(new URL("../docs/README.md", import.meta.url), "utf8");

test("no two ADRs share a number", () => {
  const byNumber = new Map();
  for (const file of adrFiles) {
    const number = file.slice(0, 4);
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  const shared = [...byNumber.values()].filter((files) => files.length > 1);
  assert.deepEqual(
    shared,
    [],
    "each ADR number is used once: renumber the later record to the next free number",
  );
});

test("every ADR heading carries its file's number", () => {
  for (const file of adrFiles) {
    const heading = readFileSync(new URL(file, adrDir), "utf8").split("\n", 1)[0];
    assert.match(heading, new RegExp(`^# ${Number(file.slice(0, 4))}\\. `), file);
  }
});

// The index entries are list items shaped `- [NNNN](adr/NNNN-title.md) Title`, so inline
// links elsewhere in docs/README.md (the guides, the ADR-0001 pointer) are not counted.
test("docs/README.md indexes every ADR once, by its own number", () => {
  const entries = [...docsReadme.matchAll(/^- \[(\d{4})\]\(adr\/([^)]+)\)/gm)];
  for (const [, label, file] of entries) {
    assert.equal(label, file.slice(0, 4), `index label ${label} links ${file}`);
  }
  assert.deepEqual(entries.map(([, , file]) => file).sort(), adrFiles);
});
