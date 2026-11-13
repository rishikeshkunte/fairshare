import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const marketing = readFileSync(join(root, "marketing.html"), "utf8");
const marketingJs = readFileSync(join(root, "js", "marketing.js"), "utf8");
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

test("marketing home has the conversion demos and a single primary CTA", () => {
  assert.match(marketing, /id="demo-amount"/);
  assert.match(marketing, /id="demo-cta"/);
  assert.match(marketing, /id="debt-demo"/);
  assert.match(marketing, /data-debt-view="simplified"/);
  assert.match(marketing, /Start free with Gmail/);
  assert.match(marketing, /id="sticky-cta"/);
  assert.match(marketing, /js\/marketing\.js/);
  assert.match(marketingJs, /intent=split&amount=/);
  assert.match(marketingJs, /track\("cta_click"/);
});

test("content pages use the same primary CTA", () => {
  ["marketing.html", "features.html", "compare.html", "use-cases.html", "faq.html"]
    .forEach(name => {
      const body = pages.find(page => page.name === name).body;
      assert.match(body, /Start free with Gmail/, `${name} has the primary CTA`);
    });
});
