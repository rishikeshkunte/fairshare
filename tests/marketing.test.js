import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const marketing = readFileSync(join(root, "marketing.html"), "utf8");
const pages = ["marketing.html", "features.html", "compare.html", "use-cases.html", "faq.html", "privacy.html", "terms.html"]
  .map(name => ({ name, body: readFileSync(join(root, name), "utf8") }));

test("marketing pages do not claim offline support or an account-free app", () => {
  pages.forEach(page => {
    assert.doesNotMatch(page.body, /offline|offline-ready|offline-first/i, `${page.name} has an offline claim`);
    assert.doesNotMatch(page.body, /no sign-up required|no account needed|sign-in is optional/i, `${page.name} has an account-free claim`);
  });
  assert.match(marketing, /currently requires a Gmail account/);
});

test("root invite links are forwarded to the app with their query and hash", () => {
  assert.match(marketing, /params\.has\("invite"\) \|\| params\.has\("joinGroup"\)/);
  assert.match(marketing, /window\.location\.replace\(`\/app\/\$\{window\.location\.search\}\$\{hash\}`\)/);
  assert.match(marketing, /window\.location\.replace\(`\/app\/\$\{window\.location\.search\}\$\{window\.location\.hash\}`\)/);
});
