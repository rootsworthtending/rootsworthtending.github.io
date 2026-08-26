--4c65ed1cff309e5f1503b887818594c86480aa1182dff29b15905c269ca4
Content-Disposition: form-data; name="worker.js"; filename="worker.js"
Content-Type: application/javascript+module

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var SITE = "https://rootsworthtending.com";
var CATALOG_URL = SITE + "/items.json";
var MIN_CENTS = 100;
var CORS = {
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
__name(json, "json");
function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}
__name(money, "money");
var CATALOG = { at: 0, items: null };
async function catalog() {
  const now = Date.now();
  if (CATALOG.items && now - CATALOG.at < 6e4)
    return CATALOG.items;
  const res = await fetch(CATALOG_URL, { cf: { cacheTtl: 30 } });
  if (!res.ok)
    throw new Error("Could not load the item list.");
  const data = await res.json();
  const items = (data.items || []).filter(function(i) {
    return i && typeof i.slug === "string" && /^[a-z0-9-]{1,30}$/.test(i.slug) && typeof i.name === "string" && i.name.length > 0 && i.name.length <= 120 && Number.isInteger(i.goal) && i.goal > 0 && i.goal <= 1e7;
  }).map(function(i) {
    return { slug: i.slug, name: i.name, goal: i.goal };
  });
  if (!items.length)
    throw new Error("The item list is empty.");
  CATALOG = { at: now, items };
  return items;
}
__name(catalog, "catalog");
function form(obj, prefix, out) {
  out = out || [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === void 0 || val === null)
      continue;
    const k = prefix ? prefix + "[" + key + "]" : key;
    if (Array.isArray(val)) {
      val.forEach(function(v, i) {
        if (v !== null && typeof v === "object")
          form(v, k + "[" + i + "]", out);
        else
          out.push(encodeURIComponent(k + "[" + i + "]") + "=" + encodeURIComponent(v));
      });
    } else if (typeof val === "object") {
      form(val, k, out);
    } else {
      out.push(encodeURIComponent(k) + "=" + encodeURIComponent(val));
    }
  }
  return out;
}
__name(form, "form");
async function stripe(env, method, path, body, idempotencyKey) {
  const init = {
    method,
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
      "Stripe-Version": "2024-06-20"
    }
  };
  if (idempotencyKey)
    init.headers["Idempotency-Key"] = idempotencyKey;
  if (body) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = form(body).join("&");
  }
  const res = await fetch("https://api.stripe.com/v1/" + path, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data && data.error && data.error.message || "Stripe " + res.status);
  }
  return data;
}
__name(stripe, "stripe");
var CACHE = { at: 0, raised: null };
function splitOf(pi) {
  const md = pi.metadata || {};
  const lines = [];
  for (const k of Object.keys(md)) {
    if (k.slice(0, 2) !== "i_")
      continue;
    const cents = parseInt(md[k], 10);
    if (!isFinite(cents) || cents <= 0)
      continue;
    lines.push({ slug: k.slice(2), cents });
  }
  return lines;
}
__name(splitOf, "splitOf");
function refundsOf(pi) {
  const md = pi.metadata || {};
  const out = {};
  for (const k of Object.keys(md)) {
    if (k.slice(0, 2) !== "r_")
      continue;
    const cents = parseInt(md[k], 10);
    if (!isFinite(cents) || cents <= 0)
      continue;
    out[k.slice(2)] = cents;
  }
  return out;
}
__name(refundsOf, "refundsOf");
function keptOf(pi) {
  const lines = splitOf(pi);
  const back = pi.latest_charge && pi.latest_charge.amount_refunded || 0;
  const refunds = refundsOf(pi);
  const kept = {};
  let attributed = 0;
  for (const l of lines) {
    const r = Math.min(refunds[l.slug] || 0, l.cents);
    attributed += r;
    kept[l.slug] = l.cents - r;
  }
  const rest = Math.max(0, back - attributed);
  const keptTotal = lines.reduce(function(s, l) {
    return s + kept[l.slug];
  }, 0);
  const keep = rest > 0 && keptTotal > 0 ? Math.max(0, (keptTotal - rest) / keptTotal) : 1;
  const out = {};
  for (const l of lines)
    out[l.slug] = Math.round(kept[l.slug] * keep);
  return out;
}
__name(keptOf, "keptOf");
async function listPayments(env) {
  const out = [];
  let starting_after = null;
  for (let page = 0; page < 40; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    qs.append("expand[]", "data.latest_charge");
    if (starting_after)
      qs.set("starting_after", starting_after);
    const list = await stripe(env, "GET", "payment_intents?" + qs.toString());
    for (const pi of list.data) {
      if (pi.status !== "succeeded")
        continue;
      if (!splitOf(pi).length)
        continue;
      out.push(pi);
    }
    if (!list.has_more || list.data.length === 0)
      break;
    starting_after = list.data[list.data.length - 1].id;
  }
  out.reverse();
  return out;
}
__name(listPayments, "listPayments");
function totalsFrom(payments) {
  const raised = {};
  for (const pi of payments) {
    const kept = keptOf(pi);
    for (const slug of Object.keys(kept))
      raised[slug] = (raised[slug] || 0) + kept[slug];
  }
  return raised;
}
__name(totalsFrom, "totalsFrom");
async function raisedBySlug(env, fresh) {
  const now = Date.now();
  if (!fresh && CACHE.raised && now - CACHE.at < 15e3)
    return CACHE.raised;
  const raised = totalsFrom(await listPayments(env));
  CACHE = { at: now, raised };
  return raised;
}
__name(raisedBySlug, "raisedBySlug");
function snapshot(items, raised) {
  const out = items.map(function(i) {
    const got2 = Math.min(raised[i.slug] || 0, i.goal);
    const remaining = Math.max(i.goal - got2, 0);
    return {
      slug: i.slug,
      name: i.name,
      goal: i.goal,
      raised: got2,
      remaining,
      pct: Math.min(100, Math.round(got2 / i.goal * 1e3) / 10),
      closed: remaining === 0
    };
  });
  const goal = out.reduce(function(s, i) {
    return s + i.goal;
  }, 0);
  const got = out.reduce(function(s, i) {
    return s + i.raised;
  }, 0);
  return {
    items: out,
    total: {
      goal,
      raised: got,
      remaining: goal - got,
      pct: goal ? Math.round(got / goal * 1e3) / 10 : 0
    }
  };
}
__name(snapshot, "snapshot");
var TERMS = [
  "Every price here is the item, its shipping, and the card fee.",
  "Roots Worth Tending is not a registered 501(c)(3). Your contribution is not tax-deductible.",
  "On November 3rd donations close. Unfinished items will be allocated top down, unless you select refund in the drop down at checkout. The last item is covered."
];
function payMessage() {
  return TERMS.join("\n\n").slice(0, 500);
}
__name(payMessage, "payMessage");
async function createSession(env, basket) {
  if (!Array.isArray(basket) || !basket.length) {
    return json({ error: "Nothing was chosen to fund." }, 400);
  }
  if (basket.length > 60) {
    return json({ error: "Too many items in one payment." }, 400);
  }
  const items = await catalog();
  const bySlug = {};
  items.forEach(function(i) {
    bySlug[i.slug] = i;
  });
  const raised = await raisedBySlug(env);
  const seen = {};
  const lines = [];
  const rejected = [];
  for (const entry of basket) {
    const slug = String(entry && entry.item || "");
    const item = bySlug[slug];
    if (!item)
      return json({ error: "That item isn't on the list." }, 400);
    if (seen[slug])
      return json({ error: "The same item was listed twice." }, 400);
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
      rejected.push({ item: slug, name: item.name, reason: "over", requested: cents, remaining });
      continue;
    }
    lines.push({ slug, name: item.name, cents });
  }
  if (rejected.length) {
    return json({ error: "check", rejected }, 409);
  }
  if (!lines.length) {
    return json({ error: "Nothing was chosen to fund." }, 400);
  }
  const total = lines.reduce(function(s, l) {
    return s + l.cents;
  }, 0);
  const metadata = {};
  lines.forEach(function(l) {
    metadata["i_" + l.slug] = String(l.cents);
  });
  const session = await stripe(env, "POST", "checkout/sessions", {
    mode: "payment",
    submit_type: "donate",
    // Naming the funded items in the return URL lets the page say something about
    // each of them. Nothing depends on it: the page reads it if it is there.
    success_url: SITE + "/winter-2026.html?funded=1&i=" + lines.map(function(l) {
      return l.slug;
    }).join(","),
    cancel_url: SITE + "/winter-2026.html",
    line_items: lines.map(function(l) {
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
      description: "Winter backpacks 2026, " + lines.length + " item" + (lines.length === 1 ? "" : "s") + " - thank you for this. Michael, Roots Worth Tending",
      metadata
    },
    metadata,
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
  return json({ url: session.url, total, lines });
}
__name(createSession, "createSession");
var SETTLED = "settled";
var CLOSED = "closed";
async function resolveOverflow(env, pi) {
  const md = pi.metadata || {};
  if (md.overflow === "refund" || md.overflow === "next")
    return md.overflow;
  try {
    const list = await stripe(
      env,
      "GET",
      "checkout/sessions?limit=1&payment_intent=" + encodeURIComponent(pi.id)
    );
    const s = list.data && list.data[0];
    for (const f of s && s.custom_fields || []) {
      if (f.key === "overflow" && f.dropdown && f.dropdown.value === "refund")
        return "refund";
    }
  } catch (err) {
  }
  return "next";
}
__name(resolveOverflow, "resolveOverflow");
function overflowOf(pi) {
  return (pi.metadata || {}).overflow === "refund" ? "refund" : "next";
}
__name(overflowOf, "overflowOf");
async function applyNet(env, pi, net, giveBack, marks, dryRun) {
  const oldRefunds = refundsOf(pi);
  const back = {};
  let backTotal = 0;
  for (const slug of Object.keys(giveBack || {})) {
    const c = Math.round(giveBack[slug]);
    if (c > 0) {
      back[slug] = c;
      backTotal += c;
    }
  }
  const metadata = {};
  const slugs = {};
  for (const k of Object.keys(pi.metadata || {})) {
    if (k.slice(0, 2) === "i_" || k.slice(0, 2) === "r_")
      slugs[k.slice(2)] = true;
  }
  for (const slug of Object.keys(net))
    slugs[slug] = true;
  for (const slug of Object.keys(back))
    slugs[slug] = true;
  for (const slug of Object.keys(slugs)) {
    const r = (oldRefunds[slug] || 0) + (back[slug] || 0);
    const n = Math.max(0, Math.round(net[slug] || 0));
    metadata["i_" + slug] = n + r > 0 ? String(n + r) : "";
    metadata["r_" + slug] = r > 0 ? String(r) : "";
  }
  for (const k of Object.keys(marks || {}))
    metadata[k] = marks[k];
  if (dryRun)
    return { id: pi.id, refund: backTotal, metadata };
  if (backTotal > 0) {
    await stripe(
      env,
      "POST",
      "refunds",
      { payment_intent: pi.id, amount: backTotal },
      pi.id + ":" + (marks && marks[CLOSED] ? "close" : "overfill")
    );
  }
  await stripe(env, "POST", "payment_intents/" + encodeURIComponent(pi.id), { metadata });
  return { id: pi.id, refund: backTotal, metadata };
}
__name(applyNet, "applyNet");
async function settlePayment(env, piId, dryRun) {
  const pi = await stripe(
    env,
    "GET",
    "payment_intents/" + encodeURIComponent(piId) + "?expand[]=latest_charge"
  );
  if (pi.status !== "succeeded")
    return { id: piId, did: "skip", why: "not succeeded" };
  if ((pi.metadata || {})[SETTLED])
    return { id: piId, did: "skip", why: "already settled" };
  if (!splitOf(pi).length)
    return { id: piId, did: "skip", why: "no itemised split" };
  const items = await catalog();
  const bySlug = {};
  items.forEach(function(i) {
    bySlug[i.slug] = i;
  });
  const payments = await listPayments(env);
  const earlier = payments.filter(function(p) {
    if (p.id === pi.id)
      return false;
    const a = p.created || 0, b = pi.created || 0;
    return a < b || a === b && p.id < pi.id;
  });
  const others = totalsFrom(earlier);
  const mine = keptOf(pi);
  const flow = await resolveOverflow(env, pi);
  const net = {};
  const spareBy = {};
  let spare = 0;
  for (const slug of Object.keys(mine)) {
    const item = bySlug[slug];
    const room = item ? Math.max(0, item.goal - (others[slug] || 0)) : 0;
    const keep = Math.min(mine[slug], room);
    net[slug] = keep;
    const over = mine[slug] - keep;
    if (over > 0) {
      spareBy[slug] = over;
      spare += over;
    }
  }
  if (spare <= 0) {
    if (!dryRun)
      await stripe(
        env,
        "POST",
        "payment_intents/" + encodeURIComponent(pi.id),
        { metadata: { settled: "1", overflow: flow } }
      );
    return { id: pi.id, did: "nothing", spare: 0 };
  }
  if (flow === "next") {
    let left = spare;
    for (const item of items) {
      if (left <= 0)
        break;
      const already = (others[item.slug] || 0) + (net[item.slug] || 0);
      const room = Math.max(0, item.goal - already);
      if (room <= 0)
        continue;
      const put = Math.min(left, room);
      net[item.slug] = (net[item.slug] || 0) + put;
      left -= put;
    }
    if (left <= 0) {
      const out = await applyNet(env, pi, net, null, { settled: "1", overflow: flow }, dryRun);
      return { id: pi.id, did: "rolled", moved: spare, refunded: 0, plan: out.metadata };
    }
    const give = {};
    let owed = left;
    for (const slug of Object.keys(spareBy)) {
      if (owed <= 0)
        break;
      const c = Math.min(spareBy[slug], owed);
      give[slug] = c;
      owed -= c;
      net[slug] = Math.max(0, net[slug] || 0);
    }
    const out2 = await applyNet(env, pi, net, give, { settled: "1", overflow: flow }, dryRun);
    return { id: pi.id, did: "rolled and refunded the rest", moved: spare - left, refunded: out2.refund };
  }
  const out3 = await applyNet(env, pi, net, spareBy, { settled: "1", overflow: flow }, dryRun);
  return { id: pi.id, did: "refunded", refunded: out3.refund };
}
__name(settlePayment, "settlePayment");
function closePlan(items, payments) {
  const raised = totalsFrom(payments);
  const unfinished = items.filter(function(i) {
    return (raised[i.slug] || 0) < i.goal;
  });
  const refunds = [];
  const pool = [];
  for (let x = unfinished.length - 1; x >= 0; x--) {
    const slug = unfinished[x].slug;
    for (const pi of payments) {
      if ((pi.metadata || {})[CLOSED])
        continue;
      const c = keptOf(pi)[slug] || 0;
      if (c <= 0)
        continue;
      (overflowOf(pi) === "refund" ? refunds : pool).push({ id: pi.id, slug, cents: c });
    }
  }
  const targets = unfinished.map(function(i) {
    return { slug: i.slug, need: i.goal };
  });
  const moves = [];
  let ti = 0;
  for (const c of pool) {
    let left = c.cents;
    while (left > 0 && ti < targets.length) {
      const t = targets[ti];
      const put = Math.min(left, t.need);
      if (c.slug !== t.slug)
        moves.push({ id: c.id, from: c.slug, to: t.slug, cents: put });
      t.need -= put;
      left -= put;
      if (t.need === 0)
        ti++;
    }
    if (left > 0)
      moves.push({ id: c.id, from: c.slug, to: null, cents: left });
  }
  const lastItem = targets.find(function(t) {
    return t.need > 0 && t.need < items.find(function(i) {
      return i.slug === t.slug;
    }).goal;
  });
  return {
    unfinished: unfinished.map(function(i) {
      return i.slug;
    }),
    refunds,
    moves,
    shortfall: lastItem ? { item: lastItem.slug, cents: lastItem.need } : null,
    untouched: targets.filter(function(t) {
      return t.need === items.find(function(i) {
        return i.slug === t.slug;
      }).goal;
    }).map(function(t) {
      return t.slug;
    })
  };
}
__name(closePlan, "closePlan");
function planSummary(plan) {
  const moved = {};
  let movedTotal = 0, strandedTotal = 0;
  for (const m of plan.moves) {
    if (!m.to) {
      strandedTotal += m.cents;
      continue;
    }
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
    movedTotal,
    movedTotalText: money(movedTotal),
    refunds: refunded,
    refundedTotal,
    refundedTotalText: refundedTotal ? money(refundedTotal) : "$0.00",
    refundCount: plan.refunds.length,
    stranded: strandedTotal,
    shortfall: plan.shortfall ? { item: plan.shortfall.item, cents: plan.shortfall.cents, text: money(plan.shortfall.cents) } : null,
    neverStarted: plan.untouched
  };
}
__name(planSummary, "planSummary");
async function runClose(env, dryRun) {
  if (!dryRun) {
    for (const p of await listPayments(env)) {
      if (!(p.metadata || {})[SETTLED])
        await settlePayment(env, p.id, false);
    }
  }
  const items = await catalog();
  const payments = await listPayments(env);
  const plan = closePlan(items, payments);
  const byId = {};
  payments.forEach(function(p) {
    byId[p.id] = p;
  });
  const perPayment = {};
  const need = /* @__PURE__ */ __name(function(id) {
    if (!perPayment[id])
      perPayment[id] = { net: Object.assign({}, keptOf(byId[id])), give: {} };
    return perPayment[id];
  }, "need");
  for (const r of plan.refunds) {
    const e = need(r.id);
    e.net[r.slug] = Math.max(0, (e.net[r.slug] || 0) - r.cents);
    e.give[r.slug] = (e.give[r.slug] || 0) + r.cents;
  }
  for (const m of plan.moves) {
    const e = need(m.id);
    e.net[m.from] = Math.max(0, (e.net[m.from] || 0) - m.cents);
    if (m.to)
      e.net[m.to] = (e.net[m.to] || 0) + m.cents;
    else
      e.give[m.from] = (e.give[m.from] || 0) + m.cents;
  }
  const done = [];
  for (const id of Object.keys(perPayment)) {
    const e = perPayment[id];
    done.push(await applyNet(env, byId[id], e.net, e.give, { closed: "1", settled: "1" }, dryRun));
  }
  return { plan, payments: done.length, refunded: done.reduce(function(s, d) {
    return s + d.refund;
  }, 0) };
}
__name(runClose, "runClose");
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        const items = await catalog();
        const key = env.STRIPE_SECRET_KEY || "";
        return json({
          ok: true,
          version: 4,
          items: items.length,
          goal: items.reduce(function(s, i) {
            return s + i.goal;
          }, 0),
          key: key ? key.slice(0, 8) : "MISSING"
        });
      }
      if (url.pathname === "/totals" && request.method === "GET") {
        const items = await catalog();
        return json(snapshot(items, await raisedBySlug(env)));
      }
      if (url.pathname === "/hook" && request.method === "POST") {
        const body = await request.json().catch(function() {
          return null;
        });
        const obj = body && body.data && body.data.object ? body.data.object : body || {};
        const id = obj.payment_intent || (typeof obj.id === "string" && obj.id.slice(0, 3) === "pi_" ? obj.id : null);
        if (!id)
          return json({ ok: true, ignored: "no payment id in this event" });
        try {
          return json(await settlePayment(env, id, false));
        } catch (err) {
          if (/No such payment_intent/i.test(String(err.message || err))) {
            return json({ ok: true, ignored: "unknown payment", id });
          }
          throw err;
        }
      }
      if (url.pathname === "/plan" && request.method === "GET") {
        const items = await catalog();
        const payments = await listPayments(env);
        return json({
          payments: payments.length,
          awaitingSettlement: payments.filter(function(p) {
            return !(p.metadata || {})[SETTLED];
          }).length,
          alreadyClosed: payments.filter(function(p) {
            return (p.metadata || {})[CLOSED];
          }).length,
          close: planSummary(closePlan(items, payments))
        });
      }
      if (url.pathname === "/checkout" && request.method === "POST") {
        const body = await request.json();
        const basket = body && body.items ? body.items : body && body.item ? [{ item: body.item, amount: body.amount }] : null;
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
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map

--4c65ed1cff309e5f1503b887818594c86480aa1182dff29b15905c269ca4--
