import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");

function loadHelpers() {
  const rulesMatch = html.match(/const KEYWORD_RULES = (\[[\s\S]*?\n    \]);/);
  assert.ok(rulesMatch, "KEYWORD_RULES exists");
  const rules = new Function(`return ${rulesMatch[1]};`)();
  const start = html.indexOf("function csvSplit");
  const end = html.indexOf("function csvFindExistingGroup", start);
  assert.ok(start >= 0 && end > start, "CSV helper block can be located");
  const block = html.slice(start, end);
  return new Function(
    "KEYWORD_RULES",
    `${block}; return { csvSplit, csvParseDate, csvMoney, csvHash, csvGroupFromFilename, csvCurrency, csvCategory };`
  )(rules);
}

const { csvSplit, csvParseDate, csvMoney, csvGroupFromFilename, csvCurrency, csvCategory } = loadHelpers();

const sample = [
  "Date\tDescription\tCategory\tCost\tCurrency\tRishikesh Kunte\tPoorva Shintre",
  "09 09 2026\tPapayas\tGeneral\t9000\tINR\t4500\t-4500",
  "24 09 2026\tChandralok\tGeneral\t2690\tINR\t1345\t-1345",
  "30 09 2026\tPoorva S. paid Rishikesh K.\tPayment\t1441\tINR\t-1441\t1441"
].join("\n");

test("parses the Splitwise sample, including tab-separated exports", () => {
  const rows = csvSplit(sample);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].slice(0, 5), ["Date", "Description", "Category", "Cost", "Currency"]);
  assert.equal(rows[0][5], "Rishikesh Kunte");
  assert.equal(rows[0][6], "Poorva Shintre");
  assert.equal(csvParseDate(rows[1][0]), "2026-09-09");
  assert.equal(csvParseDate(rows[3][0]), "2026-09-30");
  assert.equal(csvMoney(rows[1][3]), 900000);
  assert.equal(csvMoney(rows[1][5]), 450000);
  assert.equal(csvMoney(rows[1][6]), -450000);
});

test("reconstructs a single-payer expense and a payment from signed nets", () => {
  const rows = csvSplit(sample);
  const names = [rows[0][5], rows[0][6]];

  const netCells = rows[1].slice(5).map(csvMoney);
  assert.equal(netCells.reduce((a, b) => a + b, 0), 0);
  const positive = names.filter((_, index) => netCells[index] > 0);
  assert.deepEqual(positive, ["Rishikesh Kunte"]);
  const cost = csvMoney(rows[1][3]);
  const payerIndex = names.indexOf(positive[0]);
  const shares = names.map((name, index) => (index === payerIndex ? cost - netCells[index] : -netCells[index]));
  assert.deepEqual(shares, [450000, 450000]);
  assert.equal(shares.reduce((a, b) => a + b, 0), cost);

  const paymentNets = rows[3].slice(5).map(csvMoney);
  assert.deepEqual(names.filter((_, index) => paymentNets[index] > 0), ["Poorva Shintre"]);
  assert.deepEqual(names.filter((_, index) => paymentNets[index] < 0), ["Rishikesh Kunte"]);
});

test("derives the group name from the file name and maps categories and currencies", () => {
  assert.equal(csvGroupFromFilename("Splitwise-Laser Treatment.csv"), "Laser Treatment");
  assert.equal(csvGroupFromFilename("Laser-Treatment.csv"), "Laser Treatment");
  assert.equal(csvCurrency("INR"), "\u20B9");
  assert.equal(csvCurrency("usd"), "$");
  assert.equal(csvCategory("General", "Papayas"), "Other");
  assert.equal(csvCategory("Food & Drink", "Dinner"), "Food");
});

test("accepts comma-separated exports too", () => {
  const rows = csvSplit("Date,Description,Category,Cost,Currency,A,B\n09 09 2026,Papayas,General,9000,INR,4500,-4500");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].slice(5), ["4500", "-4500"]);
});
