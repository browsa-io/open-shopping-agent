// Plain words shared by the web app and the CLI: store names, money, status words per store,
// friendly error text with a next step. No DOM, no Node APIs, so both can import it.

export const STORE_NAMES = { amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target", shopify: "Shopify" };
export const ALL_STORES = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];

/** Shown for a value the store did not show. Never "?". */
export const NOT_SHOWN = "not shown";

export function storeName(store, domain) {
  return store === "shopify" && domain ? domain : STORE_NAMES[store] || store;
}

/** "$1,234.56". Unknown money gives the fallback (default "not shown"). */
export function formatCents(cents, currency = "USD") {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const sym = currency === "USD" || !currency ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency + " ";
  return `${sign}${sym}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function money(m, fallback = NOT_SHOWN) {
  return m && Number.isFinite(m.cents) ? formatCents(m.cents, m.currency) : fallback;
}

const STAGE_WORDS = { search: "searching", product: "reading the product", options: "choosing options", cart: "filling the cart", checkout: "at checkout", place_order: "placing the order" };

const BLOCK_AT = { search: "at search", product: "at the product page", options: "at the product page", cart: "at the cart", checkout: "at checkout", place_order: "at checkout" };
const BLOCK_RE = /status 40[13]|\bHTTP 40[13]\b|\b429\b|refused the (page|browser)|refused this browser|access denied|blocked|captcha|bot check|robot|are you a human|i am human|press (and|&) hold|unusual traffic|pardon our interruption/i;

/** True when a store error means the store blocked the browser (403, a bot check, a captcha). */
export function isBlock(error) {
  return BLOCK_RE.test(String(error || ""));
}

/**
 * A block in the words of the README's per-browser table: "blocked at search (403)",
 * "blocked at the cart (bot check)", "blocked at search (page refused)".
 */
export function blockWords(error, stage) {
  const raw = String(error || "");
  const status = /\b(?:status|HTTP)\s*(40[13]|429)\b/i.exec(raw)?.[1] || /\b(429)\b/.exec(raw)?.[1];
  const what = status || (/captcha|bot check|robot|are you a human|i am human|press (and|&) hold|unusual traffic|pardon our interruption/i.test(raw) ? "bot check" : "page refused");
  return `blocked ${BLOCK_AT[stage] || "by the store"} (${what})`;
}

/**
 * A store failure in plain words: a short title, one sentence that says what to do next, and the
 * action the UI offers ("retry" this store, "live" browser, or none). The raw text stays available.
 */
export function friendlyError(error, stage, store, domain) {
  const raw = String(error || "");
  const name = storeName(store, domain);
  const where = STAGE_WORDS[stage] || "";
  const r = (title, hint, action) => ({ title, hint, action, raw, stage, where });
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ECONNRESET|ERR_EMPTY_RESPONSE/i.test(raw)) {
    return r("Could not connect", `${name} did not answer on this connection. Try ${name} again, or set your own proxy in Settings.`, "retry");
  }
  if (/browser slots|slots? (are|is) (busy|full)/i.test(raw)) {
    return r("No free browser", "Every browser on your account is busy. Wait for another run to finish, then try again.", "retry");
  }
  const cap = /can cost up to \d+ credits?; this run has (\d+) of its (\d+) left/i.exec(raw);
  if (cap) {
    return r("Run limit reached", `This run used its ${cap[2]} credits before ${name} started. Try ${name} on its own, or search fewer stores at once.`, "retry");
  }
  if (/cart is empty/i.test(raw)) {
    return r("Cart came back empty", `Nothing stayed in the ${name} cart, so there is no checkout. Try ${name} again or choose another store.`, "retry");
  }
  if (isBlock(raw)) {
    // The same words as the README's per-browser table: a block is reported as a block, never as "nothing found".
    const words = blockWords(raw, stage);
    // On Browsa the engine already tried a fresh browser on a new address: say so, not just "try later".
    const fresh = /\b(both|all \d+) exit addresses\b|fresh ones? (was|were) tried/i.exec(raw);
    if (fresh) {
      const n = /all (\d+) exit addresses/i.exec(raw)?.[1];
      return r(words[0].toUpperCase() + words.slice(1), `${name} refused ${n ? `all ${n}` : "both"} addresses tried (a fresh one was opened after the first was refused). Try ${name} again in a while, or set your own proxy in Settings.`, "retry");
    }
    return r(words[0].toUpperCase() + words.slice(1), `${name} refused this browser. Try again later, or open the live browser and finish there.`, "retry");
  }
  if (/timed? ?out|Timeout \d+ms|took too long/i.test(raw)) {
    return r("Too slow", `${name} took too long ${where ? where : "to answer"}. Try ${name} again.`, "retry");
  }
  if (/context or browser has been closed|Target (page|closed)|tab died|browser closed|Session closed/i.test(raw)) {
    return r("Browser closed", `The browser closed while ${where || "working"}. Try ${name} again.`, "retry");
  }
  if (/over the .*budget/i.test(raw)) {
    return r("Over budget", "The picks cost more than your budget. Swap to cheaper picks or raise the budget.", null);
  }
  if (/sign in|log in|create an account/i.test(raw)) {
    return r("Sign-in needed", `${name} wants you to sign in. Open the live browser, sign in, then review the checkout again.`, "live");
  }
  return r("Did not finish", `${name} stopped ${where || "early"}. Try ${name} again.`, "retry");
}

/** First line of a raw engine error, without tool prefixes, for "Details". */
export function shortRaw(raw, max = 180) {
  const line = String(raw || "").split("\n")[0].replace(/^(page\.\w+|locator\.\w+|frame\.\w+):\s*/i, "").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/**
 * Per-store state from the event stream. gates: Map or Set-like of open "step:store" keys;
 * answered: Set of "step:store" keys the person said yes to (optional).
 */
export function reduceStores(events, opts = {}) {
  const stores = new Map();
  const order = [];
  let picks = null;
  let done = false;
  const get = (s) => {
    if (!stores.has(s)) {
      stores.set(s, { store: s, domain: "", shops: [], started: false, offers: 0, failure: null, failures: [], cart: null, review: null, needs: null, awaiting: null, order: null, orderState: null, liveUrl: null, exit: null, waiting: null, last: -1, lastKind: "" });
      order.push(s);
    }
    return stores.get(s);
  };
  events.forEach((e, i) => {
    switch (e.type) {
      case "parsed": for (const s of e.request.stores) get(s); break;
      case "store_started": { const st = get(e.store); st.started = true; st.liveUrl = e.liveUrl || st.liveUrl; st.exit = e.exit || st.exit; if (e.domain && st.shops.length <= 1) st.domain = e.domain; break; }
      case "store_waiting": { const st = get(e.store); st.waiting = e.waiting ? { kind: e.waiting, message: e.message || "" } : null; if (e.domain && st.shops.length <= 1) st.domain = e.domain; break; }
      case "offers": {
        const st = get(e.store); st.started = true; st.offers += e.offers.length;
        // Several Shopify shops share one card: it says "Shopify" and lists the shops, not the last one.
        for (const o of e.offers) if (o.storeDomain && !st.shops.includes(o.storeDomain)) st.shops.push(o.storeDomain);
        st.domain = st.shops.length > 1 ? "" : (e.offers[0]?.storeDomain || st.domain);
        break;
      }
      case "store_failed": { const st = get(e.store); st.failure = { stage: e.stage, error: e.error, at: i, hint: e.hint || null }; st.failures.push(st.failure); if (e.domain && st.shops.length <= 1) st.domain = e.domain; st.last = i; st.lastKind = "failed"; break; }
      case "picks": picks = e.picks; break;
      case "cart": { const st = get(e.cart.store); st.cart = e.cart; st.last = i; st.lastKind = "cart"; break; }
      case "checkout_review": { const st = get(e.review.store); st.review = e.review; st.last = i; st.lastKind = "review"; break; }
      case "needs_user": { const st = get(e.store); st.needs = e.needs; st.awaiting = null; st.last = i; st.lastKind = "needs"; break; }
      case "awaiting_approval": { const st = get(e.store); st.awaiting = e.review; st.mandateDeclined = e.mandateDeclined || null; st.needs = null; st.last = i; st.lastKind = "awaiting"; break; }
      case "order_state": {
        // proposed -> awaiting_approval -> placing -> placed | failed | unknown (the order event follows the last three)
        const st = get(e.store);
        st.orderState = e;
        if (e.domain && st.shops.length <= 1) st.domain = e.domain;
        if (e.state === "placing") { st.awaiting = null; st.order = null; st.last = i; st.lastKind = "placing"; }
        break;
      }
      case "order": { const st = get(e.result.store); st.order = e.result; st.awaiting = null; st.last = i; st.lastKind = "order"; break; }
      case "done": done = true; break;
    }
  });
  return { stores, order, picks, done };
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "$60" for whole dollars, "$59.99" otherwise. */
const dollars = (m) => (m && m.cents % 100 === 0 ? `$${(m.cents / 100).toLocaleString("en-US")}` : money(m));

/** "Bought under your up-front approval (up to $60)" for an order bought without asking, else null. */
export function upFrontText(order) {
  if (!order || order.approval_source !== "mandate" || !order.mandate?.maxTotal) return null;
  return `Bought under your up-front approval (up to ${dollars(order.mandate.maxTotal)})`;
}

/** "up to $60 per order at walmart, target, until 14:00" for the run's "Buy without asking" setting. */
export function mandateSummary(m) {
  if (!m?.maxTotal) return "";
  const parts = [`up to ${dollars(m.maxTotal)} per order`, m.stores?.length ? `at ${m.stores.join(", ")}` : "at any store in this search"];
  if (m.maxRunTotal) parts.push(`${dollars(m.maxRunTotal)} in all`);
  if (m.expiresAt) parts.push(`until ${new Date(m.expiresAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
  return parts.join(", ");
}

/** The order states a person sees: "placing", "placed", "failed", "unknown" (or null before an approval). */
export function orderStateOf(st, running) {
  if (st.order) return st.order.placed ? "placed" : st.order.state === "unknown" ? "unknown" : "failed";
  if (st.lastKind === "placing") return running ? "placing" : "unknown";
  return null;
}

/** The "check on the store" message for an order that may have gone through. */
export function unknownText(st, stopped = false) {
  const name = storeName(st.store, st.domain);
  return `${stopped ? "The agent stopped while placing this order. " : ""}${name} may have taken this order, but no order number was confirmed. Check your orders on ${name} before you try again.`;
}

/**
 * The status word for one store: { word, tone, detail }. tone is "busy", "ok", "warn", "bad" or "idle".
 * Words: Starting, Searching, AI fallback, Waiting for a browser, Reading prices, Found N offers, Nothing found, Filling cart, Cart filled,
 * Reviewing checkout, Needs you, Ready to buy, Ordered, and a failure title.
 */
export function storeStatus(st, ctx) {
  const { running, picked, gates, answered } = ctx;
  const has = (set, k) => !!set && (typeof set.has === "function" ? set.has(k) : false);
  if (st.order) {
    if (st.order.placed) return { word: "Ordered", tone: "ok", detail: [st.order.orderId ? `Order ${st.order.orderId}` : "", upFrontText(st.order)].filter(Boolean).join(". ") };
    if (st.order.state === "unknown") return { word: "Check the store", tone: "warn", detail: `Not confirmed. Check your orders on ${storeName(st.store, st.domain)} before you try again.` };
    return { word: "Not ordered", tone: "bad", detail: st.order.error || "" };
  }
  if (st.lastKind === "placing") return running ? { word: "Placing order", tone: "busy", detail: "Place order is clicked once; then the confirmation is read" } : { word: "Check the store", tone: "warn", detail: unknownText(st, true) };
  if (st.lastKind === "needs" && st.needs) return running ? { word: "Needs you", tone: "warn", detail: st.needs.message } : { word: "Stopped at checkout", tone: "warn", detail: st.needs.message };
  if (st.lastKind === "awaiting" && st.awaiting) return { word: "Ready to buy", tone: "ok", detail: money(st.awaiting.total) };
  if (st.lastKind === "failed" && st.failure) {
    const f = friendlyError(st.failure.error, st.failure.stage, st.store, st.domain);
    return { word: f.title, tone: "bad", detail: f.hint, failure: f };
  }
  if (st.lastKind === "review") return running ? { word: "Reviewing checkout", tone: "busy", detail: "" } : { word: "Checkout reviewed", tone: "idle", detail: "" };
  if (st.lastKind === "cart") {
    if (running && has(answered, `checkout:${st.store}`) && !has(gates, `checkout:${st.store}`)) return { word: "Reviewing checkout", tone: "busy", detail: "Stops before Place order" };
    return { word: "Cart filled", tone: "ok", detail: plural(st.cart.lines.length, "item") + " in the cart" };
  }
  if (running && has(answered, `cart:${st.store}`)) return { word: "Filling cart", tone: "busy", detail: "" };
  if (picked) {
    if (st.offers) return { word: `Found ${plural(st.offers, "offer")}`, tone: "ok", detail: "" };
    if (st.started) return { word: "Nothing found", tone: "warn", detail: "No offers matched. Try simpler words." };
    return { word: "Not searched", tone: "idle", detail: "" };
  }
  if (!running) {
    if (st.offers) return { word: `Found ${plural(st.offers, "offer")}`, tone: "ok", detail: "" };
    return st.started ? { word: "Stopped", tone: "idle", detail: "" } : { word: "Not searched", tone: "idle", detail: "" };
  }
  if (st.waiting) return { word: st.waiting.kind === "browser" ? "Waiting for a browser" : "AI fallback", tone: "busy", detail: st.waiting.message };
  if (st.offers) return { word: "Reading prices", tone: "busy", detail: plural(st.offers, "offer") + " so far" };
  if (st.started) return { word: "Searching", tone: "busy", detail: "" };
  return { word: "Starting", tone: "busy", detail: "Opening a browser" };
}
