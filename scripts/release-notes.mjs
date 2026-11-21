#!/usr/bin/env node
// Print one version's section of CHANGELOG.md (the GitHub Release notes for its tag).
//   node scripts/release-notes.mjs 0.2.1          # or v0.2.1
// Exits 1 with a clear message when the changelog has no section for that version, so a release
// workflow stops before it publishes anything.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The body of the "## [version]" section, without its heading; undefined when there is none. */
export function notesFor(changelog, version) {
  const v = String(version).replace(/^v/, "");
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end < 0) end = lines.findIndex((l, i) => i > start && /^\[[^\]]+\]:\s/.test(l)); // the link list at the end
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return body || undefined;
}

/** The date in the heading "## [0.2.1] - 2026-11-21", or undefined. */
export function dateFor(changelog, version) {
  const v = String(version).replace(/^v/, "").replace(/\./g, "\\.");
  return new RegExp(`^## \\[${v}\\] - (\\d{4}-\\d{2}-\\d{2})`, "m").exec(changelog)?.[1];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version>");
    process.exit(1);
  }
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
  const notes = notesFor(readFileSync(file, "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no section "## [${version.replace(/^v/, "")}]". Add the release notes there first.`);
    process.exit(1);
  }
  process.stdout.write(notes + "\n");
}
