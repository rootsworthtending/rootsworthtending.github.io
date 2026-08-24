// Roots Worth Tending - funding function (v3: basket checkout, per-item refunds)
// One payment can fund several items. Each payment carries its own itemised
// breakdown in Stripe metadata, so Stripe stays the only ledger.
//
// The item catalog is NOT in this file. It is fetched from the website, so
// adding an item is a change to items.json and never a redeploy of this Worker.

const SITE = "https://rootsworthtending.com";
const CATALOG_URL = SITE + "/items.json";
const MIN_CENTS = 100;

const CORS = {
  "Access-Control-Allow-Origin": SITE,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, CORS)
  });
}

function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

// --- Catalog ---

let CATALOG = { at: 0, items: null };

async function catalog() {
  const now = Date.now();
  if (CATALOG.items && now - CATALOG.at < 60000) return CATALOG.items;

  const res = await fetch(CATALOG_URL, { cf: { cacheTtl: 30 } });
  if (!res.ok) throw new Error("Could not load the item list.");
  const data = await res.json();

  const items = (data.items || []).filter(function (i) {
    return i && typeof i.slug === "string" && /^[a-z0-9-]{1,30}$/.test(i.slug)
      && typeof i.name === "string" && i.name.length > 0 && i.name.length <= 120
      && Number.isInteger(i.goal) && i.goal > 0 && i.goal <= 10000000;
  }).map(function (i) {
    return { slug: i.slug, name: i.name, goal: i.goal };
  });

  if (!items.length) throw new Error("The item list is empty.");
  CATALOG = { at: now, items: items };
  return items;
}

// --- Stripe REST helpers (fetch only, no SDK) ---

function form(obj, prefix, out) {
  out = out || [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const k = prefix ? prefix + "[" + key + "]" : key;
    if (Array.isArray(val)) {
      val.forEach(function (v, i) {
        if (v !== null && typeof v === "object") form(v, k + "[" + i + "]", out);
        else out.push(encodeURIComponent(k + "[" + i + "]") + "=" + encodeURIComponent(v));
      });
    } else if (typeof val === "object") {
      form(val, k, out);
    } else {
      out.push(encodeURIComponent(k) + "=" + encodeURIComponent(val));
    }
  }
  return out;
}

async function stripe(env, method, path, body) {
  const init = {
    method: method,
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Stripe-Version": "2024-06-20"
    }
  };
  if (body) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = form(body).join("&");
  }
  const res = await fetch("https://api.stripe.com/v1/" + path, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ("Stripe " + res.status));
  }
  return data;
}

// --- Totals ---
// Every succeeded payment states its own split in metadata as i_<slug> = cents.
//
// Refunds are subtracted per item. When a refund is issued, write r_<slug> =
// cents onto the PaymentIntent's metadata recording what came back for each
// item; those amounts come straight off that item and no other. Any refunded
// amount NOT covered by r_ metadata falls back to proportional netting across
// the payment's remaining lines, so a refund is never invisible even if the
// metadata step was missed.

let CACHE = { at: 0, raised: null };

function splitOf(pi) {
  const md = pi.metadata || {};
  const lines = [];
  for (const k of Object.keys(md)) {
    if (k.slice(0, 2) !== "i_") continue;
    const cents = parseInt(md[k], 10);
    if (!isFinite(cents) || cents <= 0) continue;
    lines.push({ slug: k.slice(2), cents: cents });
  }
  return lines;
}

function refundsOf(pi) {
  const md = pi.metadata || {};
  const out = {};
  for (const k of Object.keys(md)) {
    if (k.slice(0, 2) !== "r_") continue;
    const cents = parseInt(md[k], 10);
    if (!isFinite(cents) || cents <= 0) continue;
    out[k.slice(2)] = cents;
  }
  return out;
}

async function raisedBySlug(env) {
  const now = Date.now();
  if (CACHE.raised && now - CACHE.at < 15000) return CACHE.raised;

  const raised = {};
  let starting_after = null;

  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    qs.append("expand[]", "data.latest_charge");
    if (starting_after) qs.set("starting_after", starting_after);
    const list = await stripe(env, "GET", "payment_intents?" + qs.toString());

    for (const pi of list.data) {
      if (pi.status !== "succeeded") continue;
      const lines = splitOf(pi);
      if (!lines.length) continue;

      const back = (pi.latest_charge && pi.latest_charge.amount_refunded) || 0;
      const refunds = refundsOf(pi);

      const kept = {};
      let attributed = 0;
      for (const l of lines) {
        const r = Math.min(refunds[l.slug] || 0, l.cents);
        attributed += r;
        kept[l.slug] = l.cents - r;
      }

      const rest = Math.max(0, back - attributed);
      const keptTotal = lines.reduce(function (s, l) { return s + kept[l.slug]; }, 0);
      const keep = rest > 0 && keptTotal > 0 ? Math.max(0, (keptTotal - rest) / keptTotal) : 1;

      for (const l of lines) {
        raised[l.slug] = (raised[l.slug] || 0) + Math.round(kept[l.slug] * keep);
      }
    }

    if (!list.has_more || list.data.length === 0) break;
    starting_after = list.data[list.data.length - 1].id;
  }

  CACHE = { at: now, raised: raised };
  return raised;
}

function snapshot(items, raised) {
  const out = items.map(function (i) {
    const got = Math.min(raised[i.slug] || 0, i.goal);
    const remaining = Math.max(i.goal - got, 0);
    return {
      slug: i.slug,
      name: i.name,
      goal: i.goal,
      raised: got,
      remaining: remaining,
      pct: Math.min(100, Math.round((got / i.goal) * 1000) / 10),
      closed: remaining === 0
    };
  });
  const goal = out.reduce(function (s, i) { return s + i.goal; }, 0);
  const got = out.reduce(function (s, i) { return s + i.raised; }, 0);
  return {
    items: out,
    total: {
      goal: goal,
      raised: got,
      remaining: goal - got,
      pct: goal ? Math.round((got / goal) * 1000) / 10 : 0
    }
  };
}

// --- Checkout ---

// The four terms lines, word for word the same as the ones on the campaign page.
// Change one and change the other, or a donor is shown two different sets of terms.
const TERMS = [
  "Every price here is the item, its shipping, and the card fee.",
  "Roots Worth Tending is not a registered 501(c)(3). Your contribution is not tax-deductible.",
  "On November 3rd donations close. The last item is covered."
];

// Stripe rejects the whole session if this message runs past 500 characters, which
// would take checkout down. If the terms grow, the confirmation line goes first.
function payMessage(flow) {
  const chose = flow === "refund"
    ? "You chose: refund it to me."
    : "You chose: pay for the next item.";
  const full = TERMS.concat([chose]).join("\n\n");
  if (full.length <= 500) return full;
  return TERMS.join("\n\n").slice(0, 500);
}

async function createSession(env, basket, overflow) {
  if (!Array.isArray(basket) || !basket.length) {
    return json({ error: "Nothing was chosen to fund." }, 400);
  }
  if (basket.length > 60) {
    return json({ error: "Too many items in one payment." }, 400);
  }

  const items = await catalog();
  const bySlug = {};
  items.forEach(function (i) { bySlug[i.slug] = i; });

  const raised = await raisedBySlug(env);
  const seen = {};
  const lines = [];
  const rejected = [];

  for (const entry of basket) {
    const slug = String((entry && entry.item) || "");
    const item = bySlug[slug];
    if (!item) return json({ error: "That item isn't on the list." }, 400);
    if (seen[slug]) return json({ error: "The same item was listed twice." }, 400);
    seen[slug] = true;

    const cents = Math.round(Number(entry.amount));
    if (!isFinite(cents) || cents < MIN_CENTS) {
      rejected.push({ item: slug, name: item.name, reason: "min", min: MIN_CENTS });
      continue;
    }

    const already = Math.min(raised[slug] || 0, item.goal);
    const remaining = item.goal - already;

    if (remaining <= 0) {
      rejected.push({ item: slug, name: item.name, reason: "closed", remaining: 0 });
      continue;
    }
    if (cents > remaining) {
      rejected.push({ item: slug, name: item.name, reason: "over", requested: cents, remaining: remaining });
      continue;
    }

    lines.push({ slug: slug, name: item.name, cents: cents });
  }

  if (rejected.length) {
    return json({ error: "check", rejected: rejected }, 409);
  }
  if (!lines.length) {
    return json({ error: "Nothing was chosen to fund." }, 400);
  }

  const total = lines.reduce(function (s, l) { return s + l.cents; }, 0);
  const metadata = {};
  lines.forEach(function (l) { metadata["i_" + l.slug] = String(l.cents); });

  // The donor's standing answer for money that can no longer go where they chose:
  // an item that fills before this payment lands, and anything still unfinished on
  // November 3rd. Recorded on the PaymentIntent so it is readable at refund time.
  const flow = overflow === "refund" ? "refund" : "next";
  metadata.overflow = flow;

  const session = await stripe(env, "POST", "checkout/sessions", {
    mode: "payment",
    submit_type: "donate",
    success_url: SITE + "/winter-2026.html?funded=1",
    cancel_url: SITE + "/winter-2026.html",
    line_items: lines.map(function (l) {
      return {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: l.cents,
          product_data: { name: l.name }
        }
      };
    }),
    payment_intent_data: {
      description: "Roots Worth Tending - winter bags (" + lines.length + " item" + (lines.length === 1 ? "" : "s") + ")",
      metadata: metadata
    },
    metadata: metadata,
    custom_text: {
      submit: { message: payMessage(flow) }
    }
  });

  return json({ url: session.url, total: total, lines: lines });
}

// --- Router ---

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        const items = await catalog();
        const key = env.STRIPE_SECRET_KEY || "";
        return json({
          ok: true,
          version: 3,
          items: items.length,
          goal: items.reduce(function (s, i) { return s + i.goal; }, 0),
          key: key ? key.slice(0, 8) : "MISSING"
        });
      }

      if (url.pathname === "/totals" && request.method === "GET") {
        const items = await catalog();
        return json(snapshot(items, await raisedBySlug(env)));
      }

      if (url.pathname === "/checkout" && request.method === "POST") {
        const body = await request.json();
        const basket = body && body.items ? body.items
          : (body && body.item ? [{ item: body.item, amount: body.amount }] : null);
        return await createSession(env, basket, body && body.overflow);
      }

      return json({ error: "Not found." }, 404);
    } catch (err) {
      return json({ error: "Something went wrong.", detail: String(err.message || err) }, 502);
    }
  }
};
