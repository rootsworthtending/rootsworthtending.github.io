// Roots Worth Tending - funding function (v4: basket checkout, per-item refunds,
// automatic overfill settlement, and the November close)
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

async function stripe(env, method, path, body, idempotencyKey) {
  const init = {
    method: method,
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Stripe-Version": "2024-06-20"
    }
  };
  // Stripe replays the first result for a repeated key instead of acting twice.
  // Every refund this Worker issues carries one, so a retried webhook or a
  // second close cannot refund the same money twice.
  if (idempotencyKey) init.headers["Idempotency-Key"] = idempotencyKey;
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

// What a single payment currently stands for, per item, after its refunds.
function keptOf(pi) {
  const lines = splitOf(pi);
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

  const out = {};
  for (const l of lines) out[l.slug] = Math.round(kept[l.slug] * keep);
  return out;
}

// Every succeeded payment that carries a split, oldest first. Settlement and the
// close both read from this, so they see exactly what the totals see.
async function listPayments(env) {
  const out = [];
  let starting_after = null;

  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    qs.append("expand[]", "data.latest_charge");
    if (starting_after) qs.set("starting_after", starting_after);
    const list = await stripe(env, "GET", "payment_intents?" + qs.toString());

    for (const pi of list.data) {
      if (pi.status !== "succeeded") continue;
      if (!splitOf(pi).length) continue;
      out.push(pi);
    }

    if (!list.has_more || list.data.length === 0) break;
    starting_after = list.data[list.data.length - 1].id;
  }

  out.reverse();
  return out;
}

function totalsFrom(payments) {
  const raised = {};
  for (const pi of payments) {
    const kept = keptOf(pi);
    for (const slug of Object.keys(kept)) raised[slug] = (raised[slug] || 0) + kept[slug];
  }
  return raised;
}

async function raisedBySlug(env, fresh) {
  const now = Date.now();
  if (!fresh && CACHE.raised && now - CACHE.at < 15000) return CACHE.raised;

  const raised = totalsFrom(await listPayments(env));
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
  "On November 3rd donations close. Unfinished items will be allocated top down, unless you select refund in the drop down at checkout. The last item is covered."
];

// Stripe rejects the whole session if this message runs past 500 characters, which
// would take checkout down. If the terms grow, the confirmation line goes first.
function payMessage() {
  return TERMS.join("\n\n").slice(0, 500);
}

async function createSession(env, basket) {
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
      // This line is what a donor reads on the Stripe receipt, so it says thank you
      // rather than naming a transaction. It still names the drive and the count so
      // the payment stays identifiable in the Stripe dashboard.
      description: "Winter backpacks 2026, " + lines.length + " item" + (lines.length === 1 ? "" : "s")
        + " - thank you for this. Michael, Roots Worth Tending",
      metadata: metadata
    },
    metadata: metadata,
    custom_text: {
      submit: { message: payMessage() }
    },
    // The choice belongs here, where the donor is thinking about paying, rather
    // than on the page where they are still deciding what to fund. Unanswered
    // means allocate, so it is optional on purpose.
    custom_fields: [{
      key: "overflow",
      label: { type: "custom", custom: "If your money cannot go to the item you picked" },
      type: "dropdown",
      optional: true,
      dropdown: {
        options: [
          { label: "Allocate it top down", value: "next" },
          { label: "Refund it to me", value: "refund" }
        ]
      }
    }]
  });

  return json({ url: session.url, total: total, lines: lines });
}

// --- Settlement ---
// Two things can make money stop pointing at what a donor chose: the item fills
// before their payment lands, and the November close. Both follow the answer they
// already gave at checkout, recorded on the payment as overflow = next | refund.
//
// The ledger invariant, before and after: for each payment and item,
//   what that payment funded  =  i_<slug>  -  r_<slug>
// so a rewrite sets i_ to the new net PLUS whatever has been refunded. Nothing
// here ever changes the amount charged; it only moves attribution or sends money
// back, and the two always sum to the original payment.

const SETTLED = "settled";
const CLOSED = "closed";

// The donor answers on the checkout screen, so the answer lands on the Checkout
// Session and not on the payment. Resolve it once and write it onto the payment,
// where settlement and the close both look for it. Anything unanswered or
// unreadable means the default: allocate it, do not refund.
async function resolveOverflow(env, pi) {
  const md = pi.metadata || {};
  if (md.overflow === "refund" || md.overflow === "next") return md.overflow;
  try {
    const list = await stripe(env, "GET",
      "checkout/sessions?limit=1&payment_intent=" + encodeURIComponent(pi.id));
    const s = list.data && list.data[0];
    for (const f of ((s && s.custom_fields) || [])) {
      if (f.key === "overflow" && f.dropdown && f.dropdown.value === "refund") return "refund";
    }
  } catch (err) {
    // No session, or Stripe was unhappy. Fall through to the default.
  }
  return "next";
}

function overflowOf(pi) {
  return ((pi.metadata || {}).overflow === "refund") ? "refund" : "next";
}

// Rewrite one payment so it stands for the given net per item, optionally
// refunding first. Returns what it did, or what it would do.
async function applyNet(env, pi, net, giveBack, marks, dryRun) {
  const oldRefunds = refundsOf(pi);
  const back = {};
  let backTotal = 0;
  for (const slug of Object.keys(giveBack || {})) {
    const c = Math.round(giveBack[slug]);
    if (c > 0) { back[slug] = c; backTotal += c; }
  }

  const metadata = {};
  const slugs = {};
  for (const k of Object.keys(pi.metadata || {})) {
    if (k.slice(0, 2) === "i_" || k.slice(0, 2) === "r_") slugs[k.slice(2)] = true;
  }
  for (const slug of Object.keys(net)) slugs[slug] = true;
  for (const slug of Object.keys(back)) slugs[slug] = true;

  for (const slug of Object.keys(slugs)) {
    const r = (oldRefunds[slug] || 0) + (back[slug] || 0);
    const n = Math.max(0, Math.round(net[slug] || 0));
    metadata["i_" + slug] = (n + r) > 0 ? String(n + r) : "";
    metadata["r_" + slug] = r > 0 ? String(r) : "";
  }
  for (const k of Object.keys(marks || {})) metadata[k] = marks[k];

  if (dryRun) return { id: pi.id, refund: backTotal, metadata: metadata };

  if (backTotal > 0) {
    await stripe(env, "POST", "refunds",
      { payment_intent: pi.id, amount: backTotal },
      pi.id + ":" + (marks && marks[CLOSED] ? "close" : "overfill"));
  }
  await stripe(env, "POST", "payment_intents/" + encodeURIComponent(pi.id), { metadata: metadata });
  return { id: pi.id, refund: backTotal, metadata: metadata };
}

// One payment, just landed: does any of it point at an item that is already full?
async function settlePayment(env, piId, dryRun) {
  const pi = await stripe(env, "GET",
    "payment_intents/" + encodeURIComponent(piId) + "?expand[]=latest_charge");

  if (pi.status !== "succeeded") return { id: piId, did: "skip", why: "not succeeded" };
  if ((pi.metadata || {})[SETTLED]) return { id: piId, did: "skip", why: "already settled" };
  if (!splitOf(pi).length) return { id: piId, did: "skip", why: "no itemised split" };

  const items = await catalog();
  const bySlug = {};
  items.forEach(function (i) { bySlug[i.slug] = i; });

  // Only payments that landed BEFORE this one have a prior claim on an item.
  // Ranking by creation rather than by whatever order settlement happens to run in
  // means the donor who paid first keeps what they funded, and the same answer comes
  // out whether this runs live from a webhook or as a backlog at close time.
  const payments = await listPayments(env);
  const earlier = payments.filter(function (p) {
    if (p.id === pi.id) return false;
    const a = p.created || 0, b = pi.created || 0;
    return a < b || (a === b && p.id < pi.id);
  });
  const others = totalsFrom(earlier);
  const mine = keptOf(pi);
  const flow = await resolveOverflow(env, pi);

  // Keep what still fits where it was aimed; everything else is spare.
  const net = {};
  const spareBy = {};
  let spare = 0;
  for (const slug of Object.keys(mine)) {
    const item = bySlug[slug];
    const room = item ? Math.max(0, item.goal - (others[slug] || 0)) : 0;
    const keep = Math.min(mine[slug], room);
    net[slug] = keep;
    const over = mine[slug] - keep;
    if (over > 0) { spareBy[slug] = over; spare += over; }
  }

  if (spare <= 0) {
    if (!dryRun) await stripe(env, "POST", "payment_intents/" + encodeURIComponent(pi.id),
      { metadata: { settled: "1", overflow: flow } });
    return { id: pi.id, did: "nothing", spare: 0 };
  }

  if (flow === "next") {
    // Fill the top-most items that still have room, in catalog order.
    let left = spare;
    for (const item of items) {
      if (left <= 0) break;
      const already = (others[item.slug] || 0) + (net[item.slug] || 0);
      const room = Math.max(0, item.goal - already);
      if (room <= 0) continue;
      const put = Math.min(left, room);
      net[item.slug] = (net[item.slug] || 0) + put;
      left -= put;
    }
    if (left <= 0) {
      const out = await applyNet(env, pi, net, null, { settled: "1", overflow: flow }, dryRun);
      return { id: pi.id, did: "rolled", moved: spare, refunded: 0, plan: out.metadata };
    }
    // Everything is funded: there is nowhere for the rest to go but back.
    const give = {};
    let owed = left;
    for (const slug of Object.keys(spareBy)) {
      if (owed <= 0) break;
      const c = Math.min(spareBy[slug], owed);
      give[slug] = c; owed -= c;
      net[slug] = Math.max(0, (net[slug] || 0));
    }
    const out2 = await applyNet(env, pi, net, give, { settled: "1", overflow: flow }, dryRun);
    return { id: pi.id, did: "rolled and refunded the rest", moved: spare - left, refunded: out2.refund };
  }

  const out3 = await applyNet(env, pi, net, spareBy, { settled: "1", overflow: flow }, dryRun);
  return { id: pi.id, did: "refunded", refunded: out3.refund };
}

// --- The November close ---
// Money sitting on items that did not finish stops pointing at what the donor
// chose. Whoever asked for a refund gets theirs back. The rest is consolidated
// the way the drive buys: the bottom-most unfinished item pays the top-most one
// in full, then the next, until the money runs out. Where it runs out is the last
// item, and it is left unfinished on purpose.

function closePlan(items, payments) {
  const raised = totalsFrom(payments);
  const unfinished = items.filter(function (i) { return (raised[i.slug] || 0) < i.goal; });

  const refunds = [];
  const pool = [];
  for (let x = unfinished.length - 1; x >= 0; x--) {
    const slug = unfinished[x].slug;
    for (const pi of payments) {
      if ((pi.metadata || {})[CLOSED]) continue;
      const c = keptOf(pi)[slug] || 0;
      if (c <= 0) continue;
      (overflowOf(pi) === "refund" ? refunds : pool).push({ id: pi.id, slug: slug, cents: c });
    }
  }

  const targets = unfinished.map(function (i) { return { slug: i.slug, need: i.goal }; });
  const moves = [];
  let ti = 0;
  for (const c of pool) {
    let left = c.cents;
    while (left > 0 && ti < targets.length) {
      const t = targets[ti];
      const put = Math.min(left, t.need);
      if (c.slug !== t.slug) moves.push({ id: c.id, from: c.slug, to: t.slug, cents: put });
      t.need -= put;
      left -= put;
      if (t.need === 0) ti++;
    }
    if (left > 0) moves.push({ id: c.id, from: c.slug, to: null, cents: left });
  }

  const lastItem = targets.find(function (t) { return t.need > 0 && t.need < items.find(function(i){return i.slug===t.slug;}).goal; });

  return {
    unfinished: unfinished.map(function (i) { return i.slug; }),
    refunds: refunds,
    moves: moves,
    shortfall: lastItem ? { item: lastItem.slug, cents: lastItem.need } : null,
    untouched: targets.filter(function (t) { return t.need === items.find(function(i){return i.slug===t.slug;}).goal; }).map(function (t) { return t.slug; })
  };
}

// The plan, summed. The endpoint that serves this is public, so it carries totals
// and item names only: no payment ids and no per-donor amounts.
function planSummary(plan) {
  const moved = {};
  let movedTotal = 0, strandedTotal = 0;
  for (const m of plan.moves) {
    if (!m.to) { strandedTotal += m.cents; continue; }
    const k = m.from + " -> " + m.to;
    moved[k] = (moved[k] || 0) + m.cents;
    movedTotal += m.cents;
  }
  const refunded = {};
  let refundedTotal = 0;
  for (const r of plan.refunds) {
    refunded[r.slug] = (refunded[r.slug] || 0) + r.cents;
    refundedTotal += r.cents;
  }
  return {
    unfinished: plan.unfinished,
    moves: moved,
    movedTotal: movedTotal,
    movedTotalText: money(movedTotal),
    refunds: refunded,
    refundedTotal: refundedTotal,
    refundedTotalText: refundedTotal ? money(refundedTotal) : "$0.00",
    refundCount: plan.refunds.length,
    stranded: strandedTotal,
    shortfall: plan.shortfall ? { item: plan.shortfall.item, cents: plan.shortfall.cents, text: money(plan.shortfall.cents) } : null,
    neverStarted: plan.untouched
  };
}

async function runClose(env, dryRun) {
  // A webhook that never arrived would leave a payment claiming more of an item
  // than that item can hold, which would read as finished and hide the excess from
  // the consolidation. Settle those first; anything already settled is a no-op.
  if (!dryRun) {
    for (const p of await listPayments(env)) {
      if (!(p.metadata || {})[SETTLED]) await settlePayment(env, p.id, false);
    }
  }

  const items = await catalog();
  const payments = await listPayments(env);
  const plan = closePlan(items, payments);

  const byId = {};
  payments.forEach(function (p) { byId[p.id] = p; });

  const perPayment = {};
  const need = function (id) {
    if (!perPayment[id]) perPayment[id] = { net: Object.assign({}, keptOf(byId[id])), give: {} };
    return perPayment[id];
  };

  for (const r of plan.refunds) {
    const e = need(r.id);
    e.net[r.slug] = Math.max(0, (e.net[r.slug] || 0) - r.cents);
    e.give[r.slug] = (e.give[r.slug] || 0) + r.cents;
  }
  for (const m of plan.moves) {
    const e = need(m.id);
    e.net[m.from] = Math.max(0, (e.net[m.from] || 0) - m.cents);
    if (m.to) e.net[m.to] = (e.net[m.to] || 0) + m.cents;
    else e.give[m.from] = (e.give[m.from] || 0) + m.cents;
  }

  const done = [];
  for (const id of Object.keys(perPayment)) {
    const e = perPayment[id];
    done.push(await applyNet(env, byId[id], e.net, e.give, { closed: "1", settled: "1" }, dryRun));
  }

  return { plan: plan, payments: done.length, refunded: done.reduce(function (s, d) { return s + d.refund; }, 0) };
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
          version: 4,
          items: items.length,
          goal: items.reduce(function (s, i) { return s + i.goal; }, 0),
          key: key ? key.slice(0, 8) : "MISSING"
        });
      }

      if (url.pathname === "/totals" && request.method === "GET") {
        const items = await catalog();
        return json(snapshot(items, await raisedBySlug(env)));
      }

      // Stripe telling us a payment landed. The body is NOT trusted: only an id is
      // read out of it, and the payment is then fetched from Stripe and acted on as
      // Stripe reports it. A forged call can at worst make the Worker re-check a
      // real payment, which is idempotent, so this needs no signing secret.
      if (url.pathname === "/hook" && request.method === "POST") {
        const body = await request.json().catch(function () { return null; });
        const obj = (body && body.data && body.data.object) ? body.data.object : (body || {});
        const id = obj.payment_intent
          || (typeof obj.id === "string" && obj.id.slice(0, 3) === "pi_" ? obj.id : null);
        if (!id) return json({ ok: true, ignored: "no payment id in this event" });
        try {
          return json(await settlePayment(env, id, false));
        } catch (err) {
          // A payment Stripe cannot resolve is never going to resolve, so answer
          // 200 and let it go. Anything else is treated as temporary and left to
          // fail, which is what makes Stripe try again.
          if (/No such payment_intent/i.test(String(err.message || err))) {
            return json({ ok: true, ignored: "unknown payment", id: id });
          }
          throw err;
        }
      }

      // Read-only. What the close would do if it ran now, in totals only.
      if (url.pathname === "/plan" && request.method === "GET") {
        const items = await catalog();
        const payments = await listPayments(env);
        return json({
          payments: payments.length,
          awaitingSettlement: payments.filter(function (p) { return !(p.metadata || {})[SETTLED]; }).length,
          alreadyClosed: payments.filter(function (p) { return (p.metadata || {})[CLOSED]; }).length,
          close: planSummary(closePlan(items, payments))
        });
      }

      if (url.pathname === "/checkout" && request.method === "POST") {
        const body = await request.json();
        const basket = body && body.items ? body.items
          : (body && body.item ? [{ item: body.item, amount: body.amount }] : null);
        return await createSession(env, basket);
      }

      return json({ error: "Not found." }, 404);
    } catch (err) {
      return json({ error: "Something went wrong.", detail: String(err.message || err) }, 502);
    }
  },

  // The November close. The cron fires once a day across a short window rather
  // than once exactly, because the close marks every payment it touches and skips
  // anything already closed: a run that fails is retried by the next day rather
  // than lost, and a run that succeeds makes the following ones do nothing.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runClose(env, false));
  }
};
