/**
 * Loyalty signup — sandboxed widget example.
 *
 * Runs inside an opaque-origin iframe (isolation: "sandbox"). It has NO access to the parent
 * page's DOM, cookies, age gate, or checkout — by design. It renders its own UI and talks only
 * to its own backend. Keep it self-contained: no reaching for parent globals.
 */
(function () {
  "use strict";

  // Point this at YOUR list backend. Never collect payment or age data here — those are
  // platform-owned. This widget captures an email for marketing consent only.
  var ENDPOINT = "https://example.com/api/loyalty/subscribe";

  var root = document.createElement("div");
  root.style.font = "14px/1.4 system-ui, sans-serif";
  // NOTE: this innerHTML is a STATIC string literal only. Never interpolate user/URL/product
  // input into innerHTML — that's an XSS. For dynamic values use textContent or DOM methods.
  root.innerHTML =
    '<form style="display:grid;gap:8px">' +
    '<strong>Join our rewards program</strong>' +
    '<p style="margin:0;color:#666">Earn points on every order.</p>' +
    '<input type="email" name="email" placeholder="Email address" required ' +
    'style="padding:8px;border:1px solid #ccc;border-radius:6px" />' +
    '<button type="submit" style="padding:8px;border:0;border-radius:6px;cursor:pointer">Join</button>' +
    '<span data-msg role="status" style="color:#2f7d5b"></span>' +
    "</form>";

  var form = root.querySelector("form");
  var msg = root.querySelector("[data-msg]");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = form.email.value.trim();
    if (!email) return;
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email })
    })
      .then(function () {
        msg.textContent = "Thanks — you're in!";
        form.email.disabled = true;
      })
      .catch(function () {
        msg.style.color = "#b23a2e";
        msg.textContent = "Something went wrong. Please try again.";
      });
  });

  document.body.appendChild(root);
})();
