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
  if (/status 40[13]|refused the page|access denied|blocked|captcha|robot|are you a human|unusual traffic/i.test(raw)) {
    return r("Blocked by the store", `${name} refused the page. Try again later, or open the live browser and finish there.`, "retry");
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
      stores.set(s, { store: s, domain: "", started: false, offers: 0, failure: null, failures: [], cart: null, review: null, needs: null, awaiting: null, order: null, liveUrl: null, exit: null, last: -1, lastKind: "" });
      order.push(s);
    }
    return stores.get(s);
  };
  events.forEach((e, i) => {
    switch (e.type) {
      case "parsed": for (const s of e.request.stores) get(s); break;
      case "store_started": { const st = get(e.store); st.started = true; st.liveUrl = e.liveUrl || st.liveUrl; st.exit = e.exit || st.exit; if (e.domain) st.domain = e.domain; break; }
      case "offers": { const st = get(e.store); st.started = true; st.offers += e.offers.length; if (e.offers[0]) st.domain = e.offers[0].storeDomain; break; }
      case "store_failed": { const st = get(e.store); st.failure = { stage: e.stage, error: e.error, at: i, hint: e.hint || null }; st.failures.push(st.failure); if (e.domain) st.domain = e.domain; st.last = i; st.lastKind = "failed"; break; }
      case "picks": picks = e.picks; break;
      case "cart": { const st = get(e.cart.store); st.cart = e.cart; st.last = i; st.lastKind = "cart"; break; }
      case "checkout_review": { const st = get(e.review.store); st.review = e.review; st.last = i; st.lastKind = "review"; break; }
      case "needs_user": { const st = get(e.store); st.needs = e.needs; st.awaiting = null; st.last = i; st.lastKind = "needs"; break; }
      case "awaiting_approval": { const st = get(e.store); st.awaiting = e.review; st.needs = null; st.last = i; st.lastKind = "awaiting"; break; }
      case "order": { const st = get(e.result.store); st.order = e.result; st.awaiting = null; st.last = i; st.lastKind = "order"; break; }
      case "done": done = true; break;
    }
  });
  return { stores, order, picks, done };
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * The status word for one store: { word, tone, detail }. tone is "busy", "ok", "warn", "bad" or "idle".
 * Words: Starting, Searching, Reading prices, Found N offers, Nothing found, Filling cart, Cart filled,
 * Reviewing checkout, Needs you, Ready to buy, Ordered, and a failure title.
 */
export function storeStatus(st, ctx) {
  const { running, picked, gates, answered } = ctx;
  const has = (set, k) => !!set && (typeof set.has === "function" ? set.has(k) : false);
  if (st.order) return st.order.placed ? { word: "Ordered", tone: "ok", detail: st.order.orderId ? `Order ${st.order.orderId}` : "" } : { word: "Not ordered", tone: "bad", detail: st.order.error || "" };
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
  if (st.offers) return { word: "Reading prices", tone: "busy", detail: plural(st.offers, "offer") + " so far" };
  if (st.started) return { word: "Searching", tone: "busy", detail: "" };
  return { word: "Starting", tone: "busy", detail: "Opening a browser" };
}
