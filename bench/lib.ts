// Bench library: the task file, the pass rules of each stage, the results file and the README
// table. Pure functions only, so they can be tested without a browser.

import { readFile, writeFile } from "node:fs/promises";
import type { Cart, CheckoutReview, Offer, StoreId } from "../src/core/types.js";

export type BenchStage = "search" | "details" | "cart" | "checkout";
export const STAGES: BenchStage[] = ["search", "details", "cart", "checkout"];
export const STORE_IDS: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];
export const STORE_NAMES: Record<StoreId, string> = {
  amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target", shopify: "Shopify stores (named by domain)",
};

export interface SearchExpect {
  minOffers?: number;   // default 5
  minPriced?: number;   // offers with a price above 0; default = minOffers
  minRated?: number;    // offers with a star rating; default 0
  titleAny?: string[];  // words; at least minRelevant offers must contain one (case-insensitive)
  minRelevant?: number; // default 3
}

export interface BenchTask {
  id: string;
  query: string;
  domain?: string;      // Shopify shop domain; defaults to the store's domain
  stages: BenchStage[]; // search is always first; cart needs search; checkout needs cart
  expect?: SearchExpect;
  requireDelivery?: boolean; // details stage also needs shipping or a delivery text
}

export interface StoreTasks {
  store: StoreId;
  domain: string;
  tasks: BenchTask[];
}

export interface TaskFile {
  version: 1;
  zip?: string;
  searchLimit?: number;
  stores: StoreTasks[];
}

export interface StageResult {
  pass: boolean;
  ms: number;
  note?: string;        // why it failed, or what was reached ("sign-in page")
}

export interface TaskResult {
  id: string;
  query: string;
  stages: Partial<Record<BenchStage, StageResult>>;
}

export type StoreStatus = "ran" | "not_installed" | "skipped" | "error";

export interface StoreResult {
  store: StoreId;
  status: StoreStatus;
  note?: string;
  tasks: TaskResult[];
  credits?: number;     // Browsa credits this store used, when known
  ms: number;
  date?: string;        // the day this store last ran (kept when a later partial run merges results)
  run?: string;         // startedAt of the run this store's result comes from (set in a merged file)
}

/** One run behind a merged results file (latest.json). */
export interface RunRef {
  startedAt: string;
  finishedAt: string;
  commit?: string;
  creditsUsed?: number; // everything that run spent, also on results a later run replaced
  creditsEstimated?: boolean;
  maxCredits?: number;
  stores: StoreId[];    // the stores whose shown result comes from this run
}

export interface BenchResults {
  date: string;         // YYYY-MM-DD (UTC)
  startedAt: string;
  finishedAt: string;
  commit?: string;
  /**
   * One run's file: this run's own browsers and AI tasks (ledger), never the account balance.
   * A merged file (latest.json, see `runs`): the sum of the credits of the store results shown.
   */
  creditsUsed?: number;
  creditsEstimated?: boolean;
  maxCredits?: number;
  stopped?: string;     // set when the run stopped early (credit cap)
  stores: StoreResult[];
  /** Merged file only: the runs the shown store results come from, oldest first. */
  runs?: RunRef[];
  /** Merged file only: what those runs spent in all, including results a later run replaced. */
  creditsAllRuns?: number;
}

export interface StageSummary { pass: number; total: number }

export function validateTasks(data: unknown): TaskFile {
  const f = data as TaskFile;
  if (!f || f.version !== 1 || !Array.isArray(f.stores)) throw new Error("tasks.json: expected { version: 1, stores: [...] }");
  const ids = new Set<string>();
  for (const s of f.stores) {
    if (!STORE_IDS.includes(s.store)) throw new Error(`tasks.json: unknown store "${s.store}"`);
    if (!s.domain) throw new Error(`tasks.json: ${s.store} needs a domain`);
    if (!Array.isArray(s.tasks) || !s.tasks.length) throw new Error(`tasks.json: ${s.store} has no tasks`);
    for (const t of s.tasks) {
      if (!t.id || ids.has(t.id)) throw new Error(`tasks.json: missing or repeated task id "${t.id}"`);
      ids.add(t.id);
      if (!t.query?.trim()) throw new Error(`tasks.json: ${t.id} needs a query`);
      if (!Array.isArray(t.stages) || t.stages[0] !== "search") throw new Error(`tasks.json: ${t.id} must start with the search stage`);
      for (const st of t.stages) if (!STAGES.includes(st)) throw new Error(`tasks.json: ${t.id} has unknown stage "${st}"`);
      if (t.stages.includes("checkout") && !t.stages.includes("cart")) throw new Error(`tasks.json: ${t.id}: checkout needs the cart stage`);
      if (t.stages.includes("cart") && !t.stages.includes("search")) throw new Error(`tasks.json: ${t.id}: cart needs the search stage`);
    }
  }
  return f;
}

export async function loadTasks(path: string): Promise<TaskFile> {
  return validateTasks(JSON.parse(await readFile(path, "utf8")));
}

// ---- pass rules ---------------------------------------------------------------------------------

export function judgeSearch(offers: Offer[], e: SearchExpect = {}): { pass: boolean; note?: string } {
  const minOffers = e.minOffers ?? 5;
  const minPriced = e.minPriced ?? minOffers;
  const minRated = e.minRated ?? 0;
  const priced = offers.filter((o) => o.price && o.price.cents > 0).length;
  const rated = offers.filter((o) => o.rating && o.rating.stars > 0).length;
  const problems: string[] = [];
  if (offers.length < minOffers) problems.push(`${offers.length} offers, want ${minOffers}`);
  if (priced < minPriced) problems.push(`${priced} with a price, want ${minPriced}`);
  if (rated < minRated) problems.push(`${rated} with a rating, want ${minRated}`);
  if (e.titleAny?.length) {
    const words = e.titleAny.map((w) => w.toLowerCase());
    const relevant = offers.filter((o) => words.some((w) => o.title.toLowerCase().includes(w))).length;
    const want = e.minRelevant ?? 3;
    if (relevant < want) problems.push(`${relevant} relevant titles, want ${want}`);
  }
  return problems.length ? { pass: false, note: problems.join("; ") } : { pass: true, note: `${offers.length} offers` };
}

/** The offer the cart stage adds: first in stock, new, not sponsored, not a subscription. */
export function pickForCart(offers: Offer[]): Offer | undefined {
  const ok = (o: Offer) => o.inStock && !o.subscription && (!o.condition || o.condition === "new") && o.price?.cents > 0;
  return offers.find((o) => ok(o) && !o.sponsored) ?? offers.find(ok);
}

export function judgeDetails(before: Offer, after: Offer, requireDelivery = false): { pass: boolean; note?: string } {
  if (!after.price || !(after.price.cents > 0)) return { pass: false, note: "no price on the product page" };
  if (after.url && before.url && hostOf(after.url) !== hostOf(before.url)) return { pass: false, note: `left the store (${hostOf(after.url)})` };
  if (requireDelivery && after.shipping === undefined && !after.deliveryText && !after.deliveryDate) {
    return { pass: false, note: "no shipping or delivery information" };
  }
  return { pass: true };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

/** Does a cart line look like this offer? Same product id, or most of the first title words. */
export function lineMatches(offer: Offer, line: { title: string; productId?: string }): boolean {
  if (offer.productId && line.productId && offer.productId === line.productId) return true;
  const want = words(offer.title).slice(0, 6);
  if (!want.length) return false;
  const have = new Set(words(line.title));
  return want.filter((w) => have.has(w)).length / want.length >= 0.5;
}

export function judgeCart(offer: Offer, added: Cart, readBack: Cart): { pass: boolean; note?: string } {
  if (!added.lines.some((l) => lineMatches(offer, l))) return { pass: false, note: `item not in the cart after adding (${added.lines.length} lines)` };
  const line = readBack.lines.find((l) => lineMatches(offer, l));
  if (!line) return { pass: false, note: "item missing when the cart was read back" };
  if (!(line.quantity >= 1)) return { pass: false, note: `quantity ${line.quantity}` };
  return { pass: true, note: readBack.warnings.length ? `warnings: ${readBack.warnings.join("; ").slice(0, 120)}` : undefined };
}

/** Checkout passes when it reaches the sign-in or guest page, or the order review page. */
export function judgeCheckout(review: CheckoutReview): { pass: boolean; note?: string } {
  if (review.needsUser) {
    if (review.needsUser.reason === "sign_in") return { pass: true, note: "sign-in or guest page" };
    // A guest checkout that asks for the address or a payment method is the checkout page itself.
    if (review.needsUser.reason === "address") return { pass: true, note: "guest checkout (asks for an address)" };
    if (review.needsUser.reason === "payment") return { pass: true, note: "checkout (asks for a payment method)" };
    return { pass: false, note: `stopped: ${review.needsUser.reason}` };
  }
  if (review.total && review.total.cents > 0) return { pass: true, note: "order review page" };
  return { pass: false, note: "no review total and no sign-in page" };
}

// ---- summaries and the README table -------------------------------------------------------------

export function summarize(r: StoreResult): Record<BenchStage, StageSummary> {
  const out = Object.fromEntries(STAGES.map((s) => [s, { pass: 0, total: 0 }])) as Record<BenchStage, StageSummary>;
  for (const t of r.tasks) {
    for (const s of STAGES) {
      const st = t.stages[s];
      if (!st) continue;
      out[s].total++;
      if (st.pass) out[s].pass++;
    }
  }
  return out;
}

/** A plain mark: ✓ every task passed, ✗ none, "partial, 2 of 3" in between. */
function cell(s: StageSummary): string {
  if (!s.total) return "not run";
  if (s.pass === s.total) return "✓";
  if (!s.pass) return "✗";
  return `partial, ${s.pass} of ${s.total}`;
}

export const BENCH_START = "<!-- bench:start -->";
export const BENCH_END = "<!-- bench:end -->";

const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The supported-stores table: one row per store, plain marks for what the bench measured on
 * Phantom (Browsa). It gives the date of the run and claims no schedule.
 */
export function renderTable(results?: BenchResults): string {
  const head = ["| Store | Search | Cart | Reaches checkout |", "|---|---|---|---|"];
  const rows = STORE_IDS.map((id) => {
    const r = results?.stores.find((s) => s.store === id);
    if (!r || !results) return `| ${STORE_NAMES[id]} | not measured yet | not measured yet | not measured yet |`;
    if (r.status !== "ran") {
      const why = r.status === "not_installed" ? "not installed" : r.status === "skipped" ? "not run" : "run failed";
      return `| ${STORE_NAMES[id]} | ${why} | ${why} | ${why} |`;
    }
    const s = summarize(r);
    return `| ${STORE_NAMES[id]} | ${cell(s.search)} | ${cell(s.cart)} | ${cell(s.checkout)} |`;
  });
  if (!results) return [...head, ...rows].join("\n") + "\n\nNot measured yet. Run [the bench](bench/) to fill this table.";
  const dates = [...new Set(results.stores.filter((s) => s.status === "ran").map((s) => s.date ?? results.date))].sort();
  const when = dates.length > 1 ? `${day(dates[0])} to ${day(dates[dates.length - 1])}` : day(dates[0] ?? results.date);
  // The stores shown may come from more than one run (a partial re-run keeps the others): add up each store's own credits.
  const ran = results.stores.filter((s) => s.status === "ran");
  const sum = ran.every((s) => typeof s.credits === "number") ? ran.reduce((n, s) => n + (s.credits ?? 0), 0) : results.creditsUsed;
  const about = results.creditsEstimated ? "about " : "";
  // Results from more than one run: say so, name the stores that were run again, and give both
  // figures (the results shown, and everything the runs spent). The linked file says the same.
  const runs = results.runs ?? [];
  const many = runs.length > 1;
  const again = many ? runs.slice(1).flatMap((r) => r.stores).map((id) => STORE_NAMES[id]) : [];
  const runsText = many ? ` in ${runs.length} runs${again.length ? ` (${listWords(again)} ${again.length === 1 ? "was" : "were"} run again)` : ""}` : "";
  const credits = sum === undefined ? ""
    : many && results.creditsAllRuns !== undefined && results.creditsAllRuns !== sum
      ? `, ${about}${sum} Browsa credits for the results shown, ${about}${results.creditsAllRuns} for the ${runs.length} runs in all`
      : `, ${about}${sum} Browsa credits`;
  const foot = `\nMeasured ${when} on Phantom (Browsa) by [the bench](bench/)${runsText}, stopped before buying` +
    ` ([results](bench/results/latest.json)${credits}). Your own Chrome: see the browser table above.`;
  return [...head, ...rows].join("\n") + "\n" + foot;
}

function listWords(a: string[]): string {
  return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

function refOf(r: BenchResults, stores: StoreId[]): RunRef {
  return {
    startedAt: r.startedAt, finishedAt: r.finishedAt, ...(r.commit ? { commit: r.commit } : {}),
    ...(r.creditsUsed !== undefined ? { creditsUsed: r.creditsUsed } : {}), ...(r.creditsEstimated ? { creditsEstimated: true } : {}),
    ...(r.maxCredits !== undefined ? { maxCredits: r.maxCredits } : {}), stores,
  };
}

/**
 * A partial run (--stores) keeps the other stores' last results, so the README table does not
 * lose them. Stores that ran now replace the older entry.
 */
export function mergeResults(previous: BenchResults | undefined, current: BenchResults): BenchResults {
  if (!previous) return current;
  const stores = current.stores.map((s) => {
    if (s.status === "ran" || s.status === "not_installed" || s.status === "error") return s.status === "ran" ? { ...s, run: current.startedAt } : s;
    const old = previous.stores.find((p) => p.store === s.store && p.status === "ran");
    return old ? { ...old, date: old.date ?? previous.date, run: old.run ?? previous.startedAt } : s;
  });
  // The runs behind the results shown. An older run none of whose results is still shown drops out.
  const earlier = previous.runs ?? [refOf(previous, [])];
  const runs = [...earlier.filter((r) => r.startedAt !== current.startedAt), refOf(current, [])]
    .map((r) => ({ ...r, stores: stores.filter((s) => s.status === "ran" && s.run === r.startedAt).map((s) => s.store) }))
    .filter((r) => r.stores.length);
  // Everything came from this run: its own file is the whole truth.
  if (runs.length <= 1) return { ...current, stores: stores.map(({ run: _run, ...s }) => s) };
  const ran = stores.filter((s) => s.status === "ran");
  const shown = ran.every((s) => typeof s.credits === "number") ? ran.reduce((n, s) => n + (s.credits ?? 0), 0) : undefined;
  const all = runs.every((r) => typeof r.creditsUsed === "number") ? runs.reduce((n, r) => n + (r.creditsUsed ?? 0), 0) : undefined;
  const { creditsUsed: _c, creditsEstimated: _e, maxCredits: _m, ...rest } = current;
  return {
    ...rest,
    startedAt: runs[0].startedAt,
    // The top-level figure matches the stores in this file (and the README sentence that links it);
    // `runs` has each run's own figure and creditsAllRuns their sum.
    ...(shown !== undefined ? { creditsUsed: shown } : {}),
    ...(runs.some((r) => r.creditsEstimated) ? { creditsEstimated: true } : {}),
    ...(all !== undefined ? { creditsAllRuns: all } : {}),
    runs,
    stores,
  };
}

/** Replace the text between the bench markers. Throws if the markers are missing. */
export function replaceBetweenMarkers(text: string, body: string): string {
  const a = text.indexOf(BENCH_START);
  const b = text.indexOf(BENCH_END);
  if (a < 0 || b < 0 || b < a) throw new Error(`README is missing the ${BENCH_START} ... ${BENCH_END} markers`);
  return text.slice(0, a + BENCH_START.length) + "\n" + body.trim() + "\n" + text.slice(b);
}

export async function updateReadme(readmePath: string, results: BenchResults): Promise<void> {
  const text = await readFile(readmePath, "utf8");
  await writeFile(readmePath, replaceBetweenMarkers(text, renderTable(results)));
}
