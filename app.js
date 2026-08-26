(function () {
  var API = "https://roots-funding.evercaregreenroots.workers.dev";
  var state = {};

  function money(cents) {
    var s = (Math.round(cents) / 100).toFixed(2).split(".");
    return "$" + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + s[1];
  }

  function say(art, msg) {
    var el = art.querySelector(".status");
    if (el) el.textContent = msg || "";
  }

  function itemsOnPage() {
    return [].slice.call(document.querySelectorAll("article.item"));
  }

  function centsIn(input) {
    var v = parseFloat(input.value);
    if (!isFinite(v) || v <= 0) return 0;
    return Math.round(v * 100);
  }

  function buildFields() {
    itemsOnPage().forEach(function (art) {
      var actions = art.querySelector(".actions");
      if (!actions || art.querySelector("input.amount")) return;

      var h3 = art.querySelector("h3");
      var name = h3 ? h3.textContent : "this item";

      var wrap = document.createElement("span");
      wrap.className = "amtwrap";

      var sign = document.createElement("span");
      sign.className = "amtsign";
      sign.setAttribute("aria-hidden", "true");
      sign.textContent = "$";

      var input = document.createElement("input");
      input.className = "amount";
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.inputMode = "decimal";
      // The item comes first in both of these. Tabbing down a column of identical
      // openings means holding "which one is this?" in your head until the end of
      // the sentence; leading with the item answers it on the first word. The
      // visible text stays short because the card heading already says the name.
      input.setAttribute("aria-label", name + ", amount in dollars");

      var rest = document.createElement("button");
      rest.type = "button";
      rest.className = "rest-btn";
      rest.textContent = "Fund the rest";
      rest.setAttribute("aria-label", name + ", fund the rest");

      wrap.appendChild(sign);
      wrap.appendChild(input);
      actions.insertBefore(wrap, actions.firstChild);
      actions.insertBefore(rest, wrap.nextSibling);

      input.addEventListener("input", function () {
        art.removeAttribute("data-err");
        checkOne(art); updateBasket();
      });
      input.addEventListener("blur", function () { checkOne(art); updateBasket(); });
      // Enter in an amount field goes to pay. Tab still walks out one stop at a
      // time; Enter jumps to the contribute button, whose name carries the
      // total, so the second Enter is an informed one. When there is nothing
      // payable the button is hidden or dimmed and cannot take focus, so Enter
      // stays put - and if an amount is wrong, the card's status line has
      // already said why.
      input.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        checkOne(art);
        updateBasket();
        var bar = document.getElementById("basket");
        var btn = document.getElementById("basket-pay");
        if (bar && !bar.hidden && btn && !btn.disabled) btn.focus();
      });
      rest.addEventListener("click", function () {
        var it = state[art.getAttribute("data-slug")];
        if (!it || it.closed) return;
        art.removeAttribute("data-err");
        input.value = String(it.remaining / 100);
        checkOne(art);
        updateBasket();
        input.focus();
      });
    });
  }

  function checkOne(art) {
    var it = state[art.getAttribute("data-slug")];
    var input = art.querySelector("input.amount");
    if (!it || !input) return true;

    var cents = centsIn(input);
    if (!cents) {
      art.removeAttribute("data-err");
      input.removeAttribute("aria-invalid");
      say(art, "");
      return true;
    }
    // A refusal that came back from the server outranks anything we can work out
    // here, and must survive the refresh that follows it.
    if (art.hasAttribute("data-err")) return false;
    if (cents > it.remaining) {
      input.setAttribute("aria-invalid", "true");
      say(art, "That is more than this needs. " + it.name + " only needs " + money(it.remaining) + ".");
      return false;
    }
    if (cents < 100) {
      input.setAttribute("aria-invalid", "true");
      say(art, "The smallest amount for an item is one dollar.");
      return false;
    }
    input.removeAttribute("aria-invalid");
    say(art, "");
    return true;
  }

  function basketLines() {
    var out = [];
    itemsOnPage().forEach(function (art) {
      var input = art.querySelector("input.amount");
      var slug = art.getAttribute("data-slug");
      if (!input || input.disabled) return;
      var cents = centsIn(input);
      if (cents > 0) out.push({ item: slug, amount: cents });
    });
    return out;
  }

  function updateBasket() {
    var bar = document.getElementById("basket");
    if (!bar) return;

    var lines = basketLines();
    var total = lines.reduce(function (s, l) { return s + l.amount; }, 0);
    var ok = itemsOnPage().every(checkOne);

    var countEl = bar.querySelector(".basket-count");
    var totalEl = bar.querySelector(".basket-total");
    var pay = document.getElementById("basket-pay");

    if (!lines.length) {
      bar.hidden = true;
      document.body.classList.remove("has-basket");
      return;
    }

    bar.hidden = false;
    document.body.classList.add("has-basket");
    countEl.textContent = lines.length === 1 ? "1 item chosen" : lines.length + " items chosen";
    totalEl.textContent = money(total);
    pay.disabled = !ok;
    pay.textContent = ok ? "Contribute " + money(total) : "Fix the amounts above";
  }

  function render(data) {
    state = {};
    data.items.forEach(function (i) { state[i.slug] = i; });

    itemsOnPage().forEach(function (art) {
      var it = state[art.getAttribute("data-slug")];
      if (!it) return;

      var fill = art.querySelector(".fill");
      if (fill) fill.style.width = it.pct + "%";

      var label = art.querySelector(".meter-label");
      var pctEl = art.querySelector(".pct");
      var restEl = art.querySelector(".rest");
      if (pctEl) pctEl.textContent = it.pct + "% funded";
      if (restEl) restEl.textContent = it.closed ? "Fully funded" : money(it.remaining) + " still needed";
      if (label) {
        label.setAttribute("aria-valuenow", it.pct);
        label.setAttribute("aria-valuetext",
          money(it.raised) + " of " + money(it.goal) + " funded, " + it.pct + " percent, " +
          (it.closed ? "fully funded" : money(it.remaining) + " still needed"));
      }

      var input = art.querySelector("input.amount");
      var restBtn = art.querySelector(".rest-btn");
      var any = art.querySelector(".any");

      if (it.closed) {
        art.setAttribute("data-closed", "yes");
        if (input) { input.disabled = true; input.value = ""; }
        if (restBtn) restBtn.disabled = true;
        if (any) any.textContent = "Bought. Thank you.";
      } else {
        art.removeAttribute("data-closed");
        if (input) { input.disabled = false; input.max = String(Math.ceil(it.remaining / 100)); }
        if (restBtn) {
          restBtn.disabled = false;
          restBtn.textContent = "Fund the rest, " + money(it.remaining);
          restBtn.setAttribute("aria-label", it.name + ", fund the rest, " + money(it.remaining));
        }
        if (any) any.textContent = "Any amount up to " + money(it.remaining);
      }
    });

    var raised = document.querySelector("[data-total-raised]");
    if (raised) raised.textContent = money(data.total.raised);
    var goalNote = document.querySelector("[data-total-goal]");
    if (goalNote) goalNote.textContent = "Of " + money(data.total.goal) + " listed";

    var fundedCount = 0;
    data.items.forEach(function (i) { if (i.closed) fundedCount++; });
    var openCount = data.items.length - fundedCount;
    var fundedEl = document.querySelector("[data-items-funded]");
    if (fundedEl) fundedEl.textContent = fundedCount;
    var openEl = document.querySelector("[data-items-open]");
    if (openEl) openEl.textContent = openCount + " open for funding";

    var totalPct = data.total.goal > 0 ? Math.round(data.total.raised / data.total.goal * 100) : 0;
    var totalFill = document.querySelector("[data-total-fill]");
    if (totalFill) totalFill.style.width = totalPct + "%";
    var totalBar = document.querySelector("[data-total-bar]");
    if (totalBar) totalBar.setAttribute("aria-valuenow", totalPct);
    var totalPctEl = document.querySelector("[data-total-pct]");
    if (totalPctEl) totalPctEl.textContent = totalPct;

    updateBasket();
  }

  function load() {
    return fetch(API + "/totals", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.items) render(d); })
      .catch(function () {
        var note = document.querySelector("[data-live-note]");
        if (note) note.textContent = "Live totals are not loading right now. The prices below are still correct.";
      });
  }

  function barSay(msg) {
    var el = document.querySelector(".basket-status");
    if (el) el.textContent = msg || "";
  }

  function pay() {
    var lines = basketLines();
    if (!lines.length) return;

    var btn = document.getElementById("basket-pay");
    btn.disabled = true;
    barSay("Opening secure checkout.");

    fetch(API + "/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: lines })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body.url) { window.location.href = res.body.url; return; }
        btn.disabled = false;

        if (res.body && res.body.error === "check" && res.body.rejected) {
          res.body.rejected.forEach(function (bad) {
            var art = document.querySelector('article.item[data-slug="' + bad.item + '"]');
            if (!art) return;
            var input = art.querySelector("input.amount");
            if (input) input.setAttribute("aria-invalid", "true");
            art.setAttribute("data-err", "1");
            if (bad.reason === "closed") say(art, bad.name + " finished funding while you were choosing. Clear this amount and the rest will go through.");
            else if (bad.reason === "over") say(art, bad.name + " only needs " + money(bad.remaining) + " now. Lower this amount and try again.");
            else say(art, "The smallest amount for an item is one dollar.");
          });
          barSay("Some amounts need changing before this can go through. They are marked above.");
          load();
          return;
        }
        barSay((res.body && (res.body.message || res.body.error)) || "Checkout could not be started. Please try again.");
      })
      .catch(function () {
        btn.disabled = false;
        barSay("Could not reach the payment service. Please try again in a moment.");
      });
  }

  function clearAll() {
    itemsOnPage().forEach(function (art) {
      var input = art.querySelector("input.amount");
      if (input) { input.value = ""; input.removeAttribute("aria-invalid"); }
      art.removeAttribute("data-err");
      say(art, "");
    });
    barSay("");
    updateBasket();
  }

  // Shown when a visitor comes back from paying. It sits at the top of the page
  // rather than down beside the item list, and focus moves to it, so it is met
  // rather than missed: a screen reader lands on it, and everyone else sees it
  // without scrolling. A message inserted quietly into a live region on load
  // tends to be announced by nobody at all.
  function thankYou() {
    if (!/[?&]funded=/.test(window.location.search)) return;
    var wrap = document.querySelector(".wrap");
    if (!wrap) return;

    var box = document.createElement("section");
    box.className = "thanks";
    box.setAttribute("tabindex", "-1");
    box.setAttribute("aria-labelledby", "thanks-h");

    var h = document.createElement("h2");
    h.id = "thanks-h";
    h.textContent = "Thank you.";

    var msg = document.createElement("p");
    msg.textContent = "Your gift today becomes something someone will hold this winter.";

    var note = document.createElement("p");
    note.className = "thanks-note";
    note.textContent = "Your contribution is already counted in the amounts below, and Stripe has emailed your receipt.";

    box.appendChild(h);
    box.appendChild(msg);
    box.appendChild(note);
    wrap.insertBefore(box, wrap.firstChild);
    box.focus();
    addFacts(box);
  }

  // What was funded is named in the return URL, so the page can say a word about
  // each one. The words live in items.json beside the item as "fact", which means
  // writing one later is an edit to that file and nothing else: the Worker ignores
  // the field entirely. An item with no fact says nothing, and any failure here
  // leaves the thank you exactly as it was.
  function addFacts(box) {
    var m = /[?&]i=([a-z0-9,-]+)/.exec(window.location.search);
    if (!m) return;
    var want = m[1].split(",");

    fetch("items.json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var by = {};
        (data.items || []).forEach(function (i) { by[i.slug] = i; });

        var label = document.createElement("p");
        label.className = "thanks-impact";
        label.textContent = "Your impact:";

        var list = document.createElement("ul");
        list.className = "thanks-facts";
        var shown = 0;

        want.forEach(function (slug) {
          var it = by[slug];
          if (!it || typeof it.fact !== "string" || !it.fact) return;
          var li = document.createElement("li");
          var name = document.createElement("b");
          name.textContent = it.name;
          li.appendChild(name);
          li.appendChild(document.createTextNode(" " + it.fact));
          list.appendChild(li);
          shown++;
        });

        // The label only appears if there is something under it, so an item with no
        // fact written yet leaves no empty heading behind.
        if (shown) {
          var note = box.querySelector(".thanks-note");
          box.insertBefore(label, note);
          box.insertBefore(list, note);
        }
      })
      .catch(function () {});
  }

  buildFields();
  var payBtn = document.getElementById("basket-pay");
  var clearBtn = document.getElementById("basket-clear");
  if (payBtn) payBtn.addEventListener("click", pay);
  if (clearBtn) clearBtn.addEventListener("click", clearAll);

  load().then(thankYou);
  setInterval(load, 45000);
})();
