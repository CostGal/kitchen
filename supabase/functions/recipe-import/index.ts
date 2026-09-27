// recipe-import — fetch a recipe page and hand back what's on it.
//
// Only a signed-in user may call it: it must never become an open proxy.
// Deployed with verify_jwt OFF on purpose: the gateway check lets the
// publishable key through (and that key is public in this repo), and it can
// reject tokens signed with the newer asymmetric keys. So signedIn() below is
// the gate: it asks Supabase Auth who the bearer token belongs to. It fetches
// honestly (its own user agent, no challenge-solving); a site that refuses
// gets a clean `blocked` answer and the app offers paste-the-text instead.
//
// It deliberately does NOT map ingredients onto the catalogue — that needs
// the user's mp_items, which live in the app's memory. This returns the page's
// schema.org Recipe (or its text); the app parses and matches it, then shows
// the result in the recipe form as a preview. Nothing is written here.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UA = "KitchenRecipeImport/1.0 (+https://costgal.github.io/kitchen/)";
const MAX_BYTES = 3_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------- where we're allowed to go ----------
function privateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") ||
      v.startsWith("fe80") || v.startsWith("::ffff:");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
async function safeUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
      h.endsWith(".internal") || !h.includes(".")) return null;
  if (/^[\d.]+$/.test(h) || h.startsWith("[")) return privateIp(h.replace(/[\[\]]/g, "")) ? null : u;
  // Resolve and refuse anything that lands on a private address.
  try {
    const addrs = [
      ...(await Deno.resolveDns(h, "A").catch(() => [] as string[])),
      ...(await Deno.resolveDns(h, "AAAA").catch(() => [] as string[])),
    ];
    if (addrs.some(privateIp)) return null;
  } catch { /* resolver unavailable: the platform's egress rules still apply */ }
  return u;
}

async function fetchPage(start: string): Promise<{ html: string; url: string } | { error: string; status?: number }> {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    const u = await safeUrl(url);
    if (!u) return { error: "bad-url" };
    let r: Response;
    try {
      r = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "el,en;q=0.8" },
      });
    } catch {
      return { error: "unreachable" };
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      url = new URL(r.headers.get("location")!, u).toString();
      continue;
    }
    if (!r.ok) return { error: r.status === 403 || r.status === 429 || r.status === 503 ? "blocked" : "http", status: r.status };
    const reader = r.body?.getReader();
    if (!reader) return { error: "empty" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { reader.cancel(); break; }
      chunks.push(value);
    }
    const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    const html = new TextDecoder("utf-8").decode(buf);
    if (/<title>\s*Just a moment/i.test(html) || /challenges\.cloudflare\.com/.test(html) && !/ld\+json/.test(html)) {
      return { error: "blocked", status: r.status };
    }
    return { html, url: u.toString() };
  }
  return { error: "redirects" };
}

// ---------- reading the page ----------
// The app does the normalising (servings, minutes, steps, entities), so the
// page-text fallback and the structured path end in one parser. This only
// finds the Recipe object and trims it to the fields the app reads.
function isRecipe(o: any) {
  const t = o && o["@type"];
  return Array.isArray(t) ? t.includes("Recipe") : t === "Recipe";
}
function findRecipe(o: any, depth = 0): any {
  if (!o || typeof o !== "object" || depth > 6) return null;
  if (Array.isArray(o)) { for (const x of o) { const r = findRecipe(x, depth + 1); if (r) return r; } return null; }
  if (isRecipe(o)) return o;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipe(o[k], depth + 1); if (r) return r;
  }
  return null;
}
const YT = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^"'\s]*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/;

function extract(html: string, url: string) {
  const yt = (html.match(YT) || [])[1] || null;
  for (const m of html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let r: any = null;
    try { r = findRecipe(JSON.parse(m[1].trim())); } catch { /* one bad block shouldn't sink the rest */ }
    if (r) {
      const { name, recipeYield, totalTime, prepTime, cookTime, recipeIngredient, recipeInstructions, video } = r;
      return { ld: { name, recipeYield, totalTime, prepTime, cookTime, recipeIngredient, recipeInstructions, video }, yt, url };
    }
  }
  // No structured data: hand back the readable text for the app's
  // paste-a-recipe parser to have a go at.
  const body = html.replace(/<(script|style|noscript|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|li|h[1-6]|div|tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
  return body ? { text: (title + "\n" + body).slice(0, 20000), yt, url } : null;
}

async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer eyJ/.test(auth)) return false;          // a user JWT, not an API key
  const r = await fetch(Deno.env.get("SUPABASE_URL") + "/auth/v1/user", {
    headers: { Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
  }).catch(() => null);
  return !!r && r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!(await signedIn(req))) return json({ error: "signed-out" }, 401);
  let url = "";
  try { url = String((await req.json()).url || "").trim(); } catch { /* fall through */ }
  if (!url) return json({ error: "bad-url" }, 400);
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const page = await fetchPage(url);
  if ("error" in page) return json(page, 200);
  const r = extract(page.html, page.url);
  return json(r || { error: "no-recipe" });
});
