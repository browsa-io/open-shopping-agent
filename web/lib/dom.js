// Small DOM helpers: element builder, keyed re-render, API calls, toast, confirm dialog, clipboard.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Replace a container's content only when its signature changed, keeping keyboard focus. */
export function mount(container, signature, build) {
  if (container._sig === signature) return;
  container._sig = signature;
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.getAttribute("data-key") : null;
  container.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
  if (key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
export function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3600);
}

export function confirmDialog(title, body, yesLabel) {
  const d = document.getElementById("confirm");
  d.querySelector("#confirm-title").textContent = title;
  d.querySelector("#confirm-body").textContent = body;
  d.querySelector("#confirm-yes").textContent = yesLabel;
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true });
    d.returnValue = "";
    d.showModal();
    d.querySelector("button[value=no]").focus();
  });
}

export async function copyText(text, done = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // Clipboard blocked (http on another host, or permissions): fall back to a hidden textarea.
    const ta = h("textarea", { class: "sr", "aria-hidden": "true" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.("copy");
    ta.remove();
    toast(ok ? done : "Could not copy. Your browser blocked the clipboard.", !ok);
  }
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export const ago = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const elapsed = (from, to) => {
  const a = Date.parse(from);
  if (!Number.isFinite(a)) return "";
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** A small inline SVG icon by name (stroke icons, 16px, currentColor). */
const ICONS = {
  check: "M3.5 8.5l3 3 6-7",
  share: "M8 2v8M4.5 5.5L8 2l3.5 3.5M3 10v3h10v-3",
  copy: "M5 5V3h8v8h-2M3 5h8v8H3z",
  download: "M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z",
  bell: "M4 11V7a4 4 0 018 0v4l1 1.5H3L4 11zM6.5 14h3",
  retry: "M13 8a5 5 0 11-1.5-3.5M13 2.5V5h-2.5",
  ext: "M6 3H3v10h10v-3M9 2h5v5M14 2L7.5 8.5",
  search: "M7 12A5 5 0 107 2a5 5 0 000 10zM14 14l-3.5-3.5",
  key: "M2 5h12v7H2zM4.5 7.5h1M7.5 7.5h1M10.5 7.5h1M5 10h6",
  x: "M4 4l8 8M12 4l-8 8",
  minus: "M4 8h8",
  plus: "M8 4v8M4 8h8",
  sort: "M5 3v10M2.5 10.5L5 13l2.5-2.5M11 13V3M8.5 5.5L11 3l2.5 2.5",
  up: "M8 13V3M4.5 6.5L8 3l3.5 3.5",
  down: "M8 3v10M4.5 9.5L8 13l3.5-3.5",
  live: "M2 4h12v8H2zM6.5 6.5v3l3-1.5z",
};
export function icon(name, cls = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `ico ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", ICONS[name] || "");
  svg.append(p);
  return svg;
}
