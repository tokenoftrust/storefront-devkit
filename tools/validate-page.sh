#!/usr/bin/env bash
# validate-page.sh — token-cheap mechanical validation gates for a ported marketing page.
#
# Runs the dependency-free gates (HTTP render, product-boundary / commerce-404, SEO <head>,
# sitemap, secret scan, stray source refs, CSP mode) and emits ONE compact JSON object to stdout.
# The full fetched HTML is written to an ARTIFACTS DIR (not stdout) so an agent reads ~1 KB of
# summary instead of ingesting the whole page — that is the point: fewer tokens per validation.
#
# Browser gates (pixel-diff, mobile/UX, axe a11y, Lighthouse) are NOT here — they need node+playwright and
# live in the companion validate-page-browser.mjs. This script is the fast first pass; only drill
# into an artifact when a gate fails.
#
# Usage:
#   validate-page.sh <page-base> <slug> [artifacts-dir]
#     page-base : base URL that already routes to the tenant.
#                 local (path-prefix):  http://localhost:4321/shop.example
#                 prod  (host routing):  https://shop.example
#     slug      : leading-slash path, e.g. /  or  /pricing/
#
# Example:
#   ./validate-page.sh http://localhost:4321/shop.example / | jq .
#
# Site-wide validation with triage across every page of a store is in the Agency Kit.
#
# Requires: curl, grep, awk, jq.
set -uo pipefail

PAGE_BASE="${1:?usage: validate-page.sh <page-base> <slug> [artifacts-dir]}"
SLUG="${2:?missing slug (e.g. / or /pricing/)}"
ART="${3:-/tmp/sm-validate}"
BASE="${PAGE_BASE%/}"
mkdir -p "$ART"

# Site type gates the commerce-boundary + sitemap expectations. Default "marketing":
# a non-commerce tenant must 404 every commerce route and keep the sitemap commerce-free.
# "commerce" (a HYBRID tenant — raw marketing chrome around a live commerce core) instead REQUIRES the ported page to not fake commerce (shoppingLeaks:0) and
# unknown product/collection handles to 404 (no route shadowing), while ALLOWING the live
# store's /collections + /search to 200, commerce URLs in the sitemap, and the platform's own
# catalog-wired quick-view cards in the page.
MODE="${SM_SITE_TYPE:-marketing}"

# Safe filename for the slug ("/" -> "root", "/pricing/" -> "pricing").
name="$(printf '%s' "$SLUG" | sed 's#^/##; s#/$##; s#/#-#g')"; name="${name:-root}"
html="$ART/$name.html"
hdrs="$ART/$name.headers.txt"

# --- fetch page + headers (to disk, not context) -----------------------------
: > "$html"
: > "$hdrs"
# Channel selector + gate header. A bare url serves the LIVE channel, which is
# empty for a tenant mid-migration and answers 200 with the platform template.
chan() { if [ -n "${SM_PREVIEW_TOKEN:-}" ]; then case "$1" in *\?*) printf '%s&__preview=%s' "$1" "$SM_PREVIEW_TOKEN";; *) printf '%s?__preview=%s' "$1" "$SM_PREVIEW_TOKEN";; esac; else printf '%s' "$1"; fi; }
CURL_HDR=()
[ -n "${SM_GATE_HEADER:-}" ] && CURL_HDR=(-H "$SM_GATE_HEADER")
# Assets select the channel separately from pages: they are served version-scoped, and
# `?__preview=` does not reach them. BOTH cookies are required and neither alone does anything —
# `tot_preview_version` picks the snapshot, `tot_preview` authorizes it (the route verifies that
# token and refuses unless its tenant claim matches the URL). Without them a checked page renders
# from the right channel while every asset it references 404s.
if [ -n "${SM_PREVIEW_VERSION:-}" ] && [ -n "${SM_PREVIEW_TOKEN:-}" ]; then
  CURL_HDR+=(--cookie "tot_preview_version=$SM_PREVIEW_VERSION; tot_preview=$SM_PREVIEW_TOKEN")
fi
curl_with_headers() {
  if [ "${#CURL_HDR[@]}" -gt 0 ]; then curl "${CURL_HDR[@]}" "$@"; else curl "$@"; fi
}
http_raw="$(curl_with_headers -s -o "$html" -D "$hdrs" -w '%{http_code}' "$(chan "$BASE$SLUG")" || true)"
http="$((10#${http_raw:-0}))"
bytes="$(wc -c < "$html" | tr -d ' ')"

# OCCURRENCES, not matching lines. A rendered page arrives minified onto a single line, so
# `grep -c` would report 1 for every count here however many hits there are — 19 quick-view
# buttons as "1 leak", 40 leaked secrets as "1 possible private token". Every threshold below
# compares against 0, so this changes no verdict; it makes the evidence mean something.
count() { local n; n="$(grep -oiE "$1" "$2" 2>/dev/null | wc -l | tr -d ' ')"; printf '%s' "${n:-0}"; }
has()   { [ "$(count "$1" "$2")" -gt 0 ] && echo true || echo false; }
code()  { local n; n="$(curl_with_headers -s -o /dev/null -w '%{http_code}' "$(chan "$1")" || true)"; printf '%s' "$((10#${n:-0}))"; }

# --- SEO <head> presence -----------------------------------------------------
seo_canon="$(has '<link[^>]*rel="canonical"' "$html")"
seo_desc="$(has '<meta[^>]*name="description"' "$html")"
seo_og="$(has 'property="og:title"' "$html")"
seo_tw="$(has 'name="twitter:card"' "$html")"
seo_ld="$(has 'application/ld\+json' "$html")"
canon_href="$(grep -oiE '<link[^>]*rel="canonical"[^>]*href="[^"]*"' "$html" | grep -oiE 'href="[^"]*"' | head -1 | sed 's/href="//; s/"//')"

# --- product-boundary: commerce routes must 404; no shopping UI in the page ---
c_col="$(code "$BASE/collections")"
c_colh="$(code "$BASE/collections/x")"
c_prod="$(code "$BASE/products/x")"
c_search="$(code "$BASE/search?q=x")"
c_saved="$(code "$BASE/saved")"
# Commerce affordances, counted PER SIGNAL so the reported issue can name what it matched. Which
# of them is a leak depends on the declared site type, never on the tenant: `data-quickview` is
# emitted by the platform's own <ProductCard>, carrying live catalog data and wired to a served
# island bundle, so on a `commerce` tenant it is correct output and counting it there is a blocker
# no such tenant can clear. Every other signal stays a leak in both modes.
#
# The signal keys are a published contract: tools that turn these counts into issue text key on
# the names under shoppingLeakSignals.
#
# NOTE (starter limitation): we flag catalog `Product` JSON-LD + shopping UI, but NOT a bare
# `Offer` — a SaaS marketing page legitimately carries a `SoftwareApplication`/`Service` `Offer`
# (e.g. a free-trial). Distinguishing a catalog Product-Offer from a SaaS Offer is a refinement
# for the next agent (parse the JSON-LD graph rather than grep). See page-validate.md.
l_product="$(count '"@type":[[:space:]]*"Product"' "$html")"
l_cart="$(count 'add.?to.?cart' "$html")"
l_mini="$(count 'mini-?cart' "$html")"
l_quick="$(count 'data-quickview' "$html")"
# Counted toward the blocker; the rest are still reported as evidence, marked platform-emitted.
if [ "$MODE" = "commerce" ]; then
  leaks="$((l_product + l_cart + l_mini))"
  platform_emitted='["quickView"]'
else
  leaks="$((l_product + l_cart + l_mini + l_quick))"
  platform_emitted='[]'
fi

# --- sitemap: slug present, no commerce URLs ---------------------------------
curl_with_headers -s "$(chan "$BASE/sitemap.xml")" -o "$ART/$name.sitemap.xml" || true
# Compare <loc> PATHS, never a substring of the file. Callers hand this script slugs
# normalized to a trailing slash, while the platform sitemap emits content pages WITHOUT one
# (`${base}/${slug}`)
# — so a literal match on the slug found nothing for every content page, and the root slug "/"
# matched every <loc> in the file and could never fail whatever the sitemap held.
#
# The sitemap's canonical base is resolved per-request: the tenant's prod domain, or this
# path-prefixed preview/local host. Both shapes of the expected path are accepted and nothing
# looser is, so `/about` never matches `/about-us` and `/` only ever matches the homepage.
base_path="${BASE#*://}"
case "$base_path" in */*) base_path="/${base_path#*/}";; *) base_path="";; esac
sm_slug="$(awk -v slug="$SLUG" -v prefix="$base_path" '
  function norm(p) {
    sub(/[?#].*$/, "", p)
    sub(/\/+$/, "", p)
    return p == "" ? "/" : p
  }
  function loc_path(u,   rest) {
    if (u !~ /^[A-Za-z][A-Za-z0-9+.-]*:\/\//) return u
    rest = u
    sub(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "", rest)
    if (index(rest, "/") == 0) return "/"
    return substr(rest, index(rest, "/"))
  }
  BEGIN { bare = norm(slug); prefixed = norm(prefix slug); n = 0 }
  {
    line = $0
    while (match(line, /<loc>[^<]*<\/loc>/)) {
      p = norm(loc_path(substr(line, RSTART + 5, RLENGTH - 11)))
      if (p == bare || p == prefixed) n++
      line = substr(line, RSTART + RLENGTH)
    }
  }
  END { print n }
' "$ART/$name.sitemap.xml" 2>/dev/null || true)"
sm_slug="${sm_slug:-0}"
sm_commerce="$(count '/products/|/collections' "$ART/$name.sitemap.xml")"

# --- hygiene: secrets + stray un-rewritten source refs -----------------------
secrets="$(count 'secretkey|totsecretkey|-----BEGIN|api[_-]?secret|bearer [a-z0-9]{20,}' "$html")"
stray="$(count 'src="\.\./|href="[a-z0-9_-]+\.html"' "$html")"

# --- CSP mode ----------------------------------------------------------------
if   grep -qi 'content-security-policy-report-only' "$hdrs"; then csp="report-only"
elif grep -qi 'content-security-policy' "$hdrs";              then csp="enforce"
else csp="none"; fi

# --- per-gate pass/fail + assemble compact JSON ------------------------------
pass_render=$([ "$http" = 200 ] && echo true || echo false)
pass_seo=$([ "$seo_canon" = true ] && [ "$seo_desc" = true ] && [ "$seo_ld" = true ] && echo true || echo false)
if [ "$MODE" = "commerce" ]; then
  # Hybrid commerce tenant: no faked commerce in the ported page + unknown handles 404
  # (no shadowing). Live /collections, /search, /saved legitimately resolve.
  pass_boundary=$([ "$c_colh" = 404 ] && [ "$c_prod" = 404 ] && [ "$leaks" = 0 ] && echo true || echo false)
  pass_sitemap=$([ "${sm_slug:-0}" -gt 0 ] && echo true || echo false)
  sm_commerce_allowed=true
else
  pass_boundary=$([ "$c_col" = 404 ] && [ "$c_prod" = 404 ] && [ "$c_search" = 404 ] && [ "$c_saved" = 404 ] && [ "$leaks" = 0 ] && echo true || echo false)
  pass_sitemap=$([ "${sm_slug:-0}" -gt 0 ] && [ "$sm_commerce" = 0 ] && echo true || echo false)
  sm_commerce_allowed=false
fi
pass_secrets=$([ "$secrets" = 0 ] && echo true || echo false)
pass_stray=$([ "$stray" = 0 ] && echo true || echo false)

jq -n \
  --arg slug "$SLUG" --arg base "$BASE" --argjson http "$http" --argjson bytes "$bytes" \
  --argjson seoCanon "$seo_canon" --argjson seoDesc "$seo_desc" --argjson seoOg "$seo_og" \
  --argjson seoTw "$seo_tw" --argjson seoLd "$seo_ld" --arg canon "${canon_href:-}" \
  --argjson cCol "$c_col" --argjson cColH "$c_colh" --argjson cProd "$c_prod" \
  --argjson cSearch "$c_search" --argjson cSaved "$c_saved" --argjson leaks "$leaks" \
  --argjson lProduct "$l_product" --argjson lCart "$l_cart" --argjson lMini "$l_mini" \
  --argjson lQuick "$l_quick" --argjson platformEmitted "$platform_emitted" \
  --argjson smSlug "${sm_slug:-0}" --argjson smCommerce "$sm_commerce" \
  --argjson smCommerceAllowed "$sm_commerce_allowed" \
  --argjson secrets "$secrets" --argjson stray "$stray" --arg csp "$csp" \
  --argjson pRender "$pass_render" --argjson pSeo "$pass_seo" --argjson pBoundary "$pass_boundary" \
  --argjson pSitemap "$pass_sitemap" --argjson pSecrets "$pass_secrets" --argjson pStray "$pass_stray" \
  --arg artifact "$html" --arg mode "$MODE" \
  '{
    slug:$slug, base:$base, mode:$mode, http:$http, bytes:$bytes, artifact:$artifact,
    gates: {
      render:   { pass:$pRender, http:$http },
      seo:      { pass:$pSeo, canonical:$seoCanon, description:$seoDesc, ogTitle:$seoOg,
                  twitter:$seoTw, jsonLd:$seoLd, canonicalHref:$canon },
      boundary: { pass:$pBoundary,
                  commerce404: { collections:$cCol, collectionsHandle:$cColH, products:$cProd,
                                 search:$cSearch, saved:$cSaved },
                  shoppingLeaks:$leaks,
                  shoppingLeakSignals: { productJsonLd:$lProduct, addToCart:$lCart,
                                         miniCart:$lMini, quickView:$lQuick },
                  platformEmittedSignals:$platformEmitted },
      sitemap:  { pass:$pSitemap, hasSlug: ($smSlug>0), commerceUrls:$smCommerce,
                  commerceUrlsAllowed:$smCommerceAllowed },
      secrets:  { pass:$pSecrets, hits:$secrets },
      strayRefs:{ pass:$pStray, hits:$stray },
      csp:      { mode:$csp }
    }
  } | . + { ok: ([.gates.render.pass,.gates.seo.pass,.gates.boundary.pass,.gates.sitemap.pass,.gates.secrets.pass,.gates.strayRefs.pass] | all) }'
echo "Site-wide validation with triage across every page is in the Agency Kit." >&2
