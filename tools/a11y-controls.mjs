// Accessibility check: what a screen reader would announce for every link and
// button on the site, and what is wrong with it.
//
// This exists to replace asking a sighted person to look at something, so the
// report is plain text, one fact per line, readable top to bottom. No tables and
// no aligned columns.
//
// It runs against the RENDERED page in a headless browser, not against the HTML
// source. That is not a preference. On the winter drive page the amount fields and
// the Fund the rest buttons are built by JavaScript at runtime, so a source parse
// finds none of them, and those are exactly the controls most likely to be wrong.
//
// The accessible name computed here APPROXIMATES the browser algorithm. It is not
// an implementation of accname. It follows the order that matters in practice:
// aria-labelledby, then aria-label, then visible text including the alt of any
// image inside, then title. Text inside an aria-hidden="true" subtree is ignored.
// Real browsers consider more sources than this and disagree with each other at
// the edges. Treat a finding as a thing to go and look at, not as a verdict.

import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : null;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    try {
      const body = await readFile(join(ROOT, path === "/" ? "/index.html" : path));
      res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// The page asks the Worker for live totals before it builds anything. In CI that
// call cannot succeed: the Worker only answers the real origin. So it is answered
// here with every item open and nothing raised, which is the state that causes the
// most controls to be built and therefore the most to be checked.
async function fakeTotals() {
  const catalog = JSON.parse(await readFile(join(ROOT, "items.json"), "utf8"));
  const items = (catalog.items || []).map((i) => ({
    slug: i.slug, name: i.name, goal: i.goal,
    raised: 0, remaining: i.goal, pct: 0, closed: false
  }));
  const goal = items.reduce((s, i) => s + i.goal, 0);
  return { total: { raised: 0, goal, remaining: goal }, items };
}

const COLLECT = () => {
  const GENERIC = ["click here", "click", "here", "read more", "more", "learn more",
    "this link", "link", "details", "continue", "submit", "go"];
  const FILE_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "zip"];

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const hidden = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  };

  // Visible text, skipping anything a screen reader would not announce, and
  // counting the alt text of images the way a browser folds them into the name.
  const textOf = (el) => {
    let out = "";
    const walk = (node) => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (node.getAttribute("aria-hidden") === "true") return;
      const tag = node.tagName.toLowerCase();
      if (tag === "img") { out += " " + (node.getAttribute("alt") || "") + " "; return; }
      if (tag === "input") {
        const t = (node.getAttribute("type") || "").toLowerCase();
        if (t === "submit" || t === "button" || t === "reset") out += " " + (node.value || "") + " ";
        if (t === "image") out += " " + (node.getAttribute("alt") || "") + " ";
        return;
      }
      for (const c of node.childNodes) walk(c);
    };
    for (const c of el.childNodes) walk(c);
    return norm(out);
  };

  // Approximation of the browser's accessible name calculation. See the file header.
  const accName = (el) => {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length) {
      const parts = ids.map((id) => {
        const t = document.getElementById(id);
        if (!t) return "";
        return norm(t.getAttribute("aria-label") || textOf(t) || t.textContent);
      }).filter(Boolean);
      if (parts.length) return { name: norm(parts.join(" ")), from: "aria-labelledby" };
    }
    const label = norm(el.getAttribute("aria-label"));
    if (label) return { name: label, from: "aria-label" };

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "image") {
        const alt = norm(el.getAttribute("alt"));
        if (alt) return { name: alt, from: "the alt text" };
      } else {
        const v = norm(el.value);
        if (v) return { name: v, from: "the value" };
      }
    }
    const vis = textOf(el);
    if (vis) return { name: vis, from: "its visible text" };

    const title = norm(el.getAttribute("title"));
    if (title) return { name: title, from: "the title attribute" };

    return { name: "", from: "nothing" };
  };

  const SELECTOR = [
    "a[href]", "button",
    'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]', 'input[type="image"]',
    '[role="button"]', '[role="link"]'
  ].join(",");

  const els = Array.from(document.querySelectorAll(SELECTOR));

  return els.map((el, order) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const { name, from } = accName(el);
    const href = el.getAttribute("href") || "";
    const resolved = href ? new URL(href, location.href).href : "";

    // Where this control goes, when that is knowable. Links have an href. A button
    // has no destination of its own, so the nearest thing it is attached to stands
    // in for one, which is what makes eight buttons on eight different items count
    // as eight destinations rather than one.
    let dest = resolved;
    if (!dest) {
      const form = el.closest("form");
      if (form && form.getAttribute("action")) dest = "form:" + form.getAttribute("action");
      else if (el.id) dest = "control:" + el.id;
      else {
        const owner = el.closest("[data-slug],[id]");
        if (owner) dest = "within:" + (owner.getAttribute("data-slug") || owner.id);
      }
    }

    const nativeControl = tag === "a" || tag === "button" || tag === "input";

    // Whether it can be reached right now. Controls inside a closed dialog are
    // still reported, because they become reachable, but the report says so.
    let reachable = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    for (let x = el; x && x.nodeType === 1; x = x.parentElement) {
      if (x.hasAttribute("hidden") || x.getAttribute("aria-hidden") === "true") { reachable = false; break; }
    }
    const clickHandler = el.hasAttribute("onclick");

    return {
      order,
      tag,
      role,
      name,
      nameFrom: from,
      visible: textOf(el),
      href,
      dest,
      target: el.getAttribute("target") || "",
      native: nativeControl,
      reachable,
      fauxControl: (tag === "div" || tag === "span") && (clickHandler || role === "button" || role === "link"),
      onclick: clickHandler,
      generic: GENERIC.includes(name.toLowerCase()),
      fileExt: (() => {
        const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(href);
        const ext = m ? m[1].toLowerCase() : "";
        return FILE_EXT.includes(ext) ? ext : "";
      })()
    };
  });
};

function stripNumbers(s) {
  return s.replace(/[0-9$£€¥,.]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function where(c) {
  return c.reachable
    ? `It is control number ${c.order + 1} in reading order.`
    : `It is control number ${c.order + 1} in reading order, currently inside something hidden, so it is only reachable once that opens.`;
}

function describe(c) {
  if (c.fauxControl) return `A ${c.tag} acting as a control`;
  if (c.tag === "a") return "A link";
  if (c.tag === "button") return "A button";
  if (c.tag === "input") return "An input button";
  return `A ${c.tag} with role ${c.role}`;
}

function analyse(page, controls) {
  const lines = [];
  const failures = [];
  const say = (s) => lines.push(s);

  say("");
  say(`PAGE: ${page}`);
  say(`Controls a screen reader would reach on this page: ${controls.length}.`);

  const native = controls.filter((c) => !c.fauxControl);
  const faux = controls.filter((c) => c.fauxControl);
  say(`Real links and buttons: ${native.length}.`);
  say(`Things acting like controls without being controls: ${faux.length}.`);
  say("");

  let n = 0;
  const finding = (headline, detail, fails) => {
    n++;
    say(`Finding ${n}.`);
    say(headline);
    for (const d of detail) say(d);
    if (fails) { say("This one fails the build."); failures.push(`${page}: ${headline}`); }
    say("");
  };

  // No accessible name at all.
  for (const c of controls.filter((c) => !c.name)) {
    finding(
      `${describe(c)} has no name at all, so a screen reader announces only that it is there.`,
      [where(c),
       c.href ? `It points at ${c.href}.` : "It has no href.",
       "Give it visible text, or an aria-label if it has none."],
      true
    );
  }

  // Same name, different destinations.
  const byName = new Map();
  for (const c of controls) {
    if (!c.name) continue;
    const k = c.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  for (const [, group] of byName) {
    const known = group.filter((c) => c.dest);
    const dests = new Set(known.map((c) => c.dest));
    if (known.length >= 2 && dests.size >= 2) {
      const detail = [
        `${known.length} controls are all announced as "${known[0].name}".`,
        `They lead to ${dests.size} different places, so hearing the name does not tell anyone which one this is.`
      ];
      for (const c of known) {
        detail.push(`One of them is at position ${c.order + 1} and goes to ${c.dest}.`);
      }
      detail.push("Give each one a name that says which thing it acts on.");
      finding(`Several controls share the name "${known[0].name}" but do different things.`, detail, true);
    }
  }

  // Name does not contain the visible text: voice control says the words and nothing happens.
  for (const c of controls) {
    if (!c.name || !c.visible) continue;
    if (c.name.toLowerCase().includes(c.visible.toLowerCase())) continue;
    finding(
      `${describe(c)} is announced as something other than what it says on screen.`,
      ["Someone using voice control reads the words out and nothing happens.",
       `The words on screen are: ${c.visible}`,
       `The name it answers to is: ${c.name}`,
       `The name comes from ${c.nameFrom}.`,
       "Make the name start with the words that are visible."],
      false
    );
  }

  // Generic names.
  for (const c of controls.filter((c) => c.generic)) {
    finding(
      `${describe(c)} is named "${c.name}", which says nothing out of context.`,
      ["Screen reader users often pull up a list of the links on a page, where each name stands alone.",
       where(c),
       c.href ? `It points at ${c.href}.` : "It has no href.",
       "Name it after where it goes or what it does."],
      false
    );
  }

  // Opens a new tab without saying so.
  for (const c of controls) {
    if (c.target !== "_blank") continue;
    if (/new (window|tab)/i.test(c.name)) continue;
    finding(
      `${describe(c)} opens a new tab without saying so.`,
      [`It is announced as "${c.name || "nothing"}".`,
       where(c),
       "The window changing with no warning is disorienting, and the back button stops working.",
       "Add the words new tab to the name."],
      false
    );
  }

  // File links that do not say what they are.
  for (const c of controls) {
    if (!c.fileExt) continue;
    const said = new RegExp(c.fileExt, "i").test(c.name);
    const size = /\b\d+(\.\d+)?\s?(kb|mb|gb|bytes)\b/i.test(c.name);
    if (said && size) continue;
    finding(
      `${describe(c)} downloads a ${c.fileExt.toUpperCase()} file without saying what it is.`,
      [`It is announced as "${c.name}".`,
       said ? "The name says the file type but not the size." : "The name says neither the file type nor the size.",
       `It points at ${c.href}.`,
       "Put the type and the size in the name."],
      false
    );
  }

  // Faux controls, reported apart from the real ones.
  for (const c of faux) {
    finding(
      `A ${c.tag} is being used as a control instead of a button or a link.`,
      [`It is announced as "${c.name || "nothing"}".`,
       c.onclick ? "It has an onclick handler." : `It has role ${c.role}.`,
       "A div or a span is not focusable by keyboard and does not respond to the space bar the way a button does.",
       "Use a button element, or a link if it goes somewhere."],
      false
    );
  }

  // Three or more controls whose names are the same once digits, currency symbols,
  // commas and periods are taken out. This catches a column of buttons that differ
  // only by a dollar amount.
  //
  // These are deliberately NOT required to be next to each other in the source. A
  // card list interleaves a link and a button per card, so the buttons in such a
  // column are never adjacent, and requiring adjacency misses the exact case this
  // rule exists for. Confirmed on this site: eight Fund the rest buttons that an
  // adjacency test reports as clean.
  const stripped = new Map();
  for (const c of controls) {
    const key = stripNumbers(c.name);
    if (!key) continue;
    if (!stripped.has(key)) stripped.set(key, []);
    stripped.get(key).push(c);
  }
  for (const [key, group] of stripped) {
    if (group.length < 3) continue;
    const varied = new Set(group.map((c) => c.name)).size > 1;
    const detail = [
      `${group.length} controls all reduce to the same words once numbers are removed.`,
      `What they have in common is: ${key}`,
      varied
        ? "They differ only by a number, so tabbing through them sounds like one control repeating with different figures."
        : "They are announced identically, so tabbing through them sounds like the same control over and over."
    ];
    for (const c of group) detail.push(`Position ${c.order + 1} is announced as "${c.name}".`);
    detail.push(varied
      ? "Put the thing each one acts on into its name, ahead of the number."
      : "Put the thing each one acts on into its name.");
    finding("A column of controls that sound the same.", detail, false);
  }

  if (n === 0) say("Nothing wrong found on this page.");
  return { lines, failures, count: n };
}

const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const totals = await fakeTotals();

const pages = (await readdir(ROOT)).filter((f) => f.endsWith(".html")).sort();

const browser = await chromium.launch();
const context = await browser.newContext();

// Answer the Worker so the page builds everything it builds in real life.
await context.route("**/*.workers.dev/**", (route) => {
  if (route.request().url().endsWith("/totals")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(totals) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
await context.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, body: "" }));
await context.route("https://fonts.gstatic.com/**", (r) => r.abort());

const out = [];
out.push("ACCESSIBILITY CHECK: LINKS AND BUTTONS");
out.push("");
out.push("This lists what a screen reader would announce for every link and button, and what is wrong with it.");
out.push("It runs against the page after JavaScript has built its controls, not against the HTML source.");
out.push("The accessible name is an approximation of the browser algorithm, not an implementation of it.");
out.push("A finding is something to go and look at rather than a verdict.");
out.push("");
out.push(`Pages checked: ${pages.length}.`);

let failures = [];
let total = 0;

for (const page of pages) {
  const p = await context.newPage();
  await p.goto(`${base}/${page}`, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  const controls = await p.evaluate(COLLECT);
  const r = analyse(page, controls);
  out.push(...r.lines);
  failures = failures.concat(r.failures);
  total += r.count;
  await p.close();
}

out.push("");
out.push("SUMMARY");
out.push(`Findings in total: ${total}.`);
out.push(`Findings that fail the build: ${failures.length}.`);
for (const f of failures) out.push(`Failing: ${f}`);
if (!failures.length) out.push("Nothing found that fails the build.");
out.push("");
out.push("A finding that fails the build is either a control with no name at all or several controls sharing one name while doing different things.");
out.push("Everything else is reported without failing.");

const text = out.join("\n") + "\n";
process.stdout.write(text);
if (OUT) await writeFile(OUT, text);

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
