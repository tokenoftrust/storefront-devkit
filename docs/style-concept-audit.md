# Style-concept audit

The style-concept audit is a single-store quality check. It reads a store's theme CSS, page HTML and
migration manifest and reports whether the shared look is extracted, readable, on the current concept
version, and documented by an approved style guide. It is report-first: it never edits page CSS.

The manifest it validates is described by [`style-concept.manifest.schema.json`](../tools/style-concept.manifest.schema.json)
(JSON Schema). Site-wide propagation and the client approval method that builds on this audit are part
of the Agency Kit.

## Usage

```bash
style-concept-audit --store <store> --manifest <manifest> --out <scratch>/style.json | jq '{gates,summary}'
```

- `--strict` exits non-zero if the storyboard or `styleGaps[]` are missing.
- `--sync-hashes` recomputes manifest stylesheet `sha256` and `bytes` from disk for `themes[]` and
  `styleConcept.stylesheet` (and legacy `styleConcept.sha256` aliases) before auditing. It does not
  create or approve a new concept version.
- `--requirements` prints the gate contract below as JSON, so workers do not need to read source.
- `--schema <path>` validates against a different manifest schema.

Thresholds are tunable:

```bash
SM_INLINE_CSS_MAX_BYTES=4096 SM_CSS_DUPLICATE_RATIO_MAX=0.25 style-concept-audit --store <store>

SM_READABILITY_LINE_MAX=160 SM_READABILITY_LONG_LINE_RATIO_MAX=0.05 \
SM_READABILITY_MINIFIED_LINE_RATIO_MAX=0.01 SM_READABILITY_CSS_DENSITY_MAX=3.5 \
  style-concept-audit --store <store>
```

## Detection contract

| Gate | Sources | Passes when | Evidence |
| --- | --- | --- | --- |
| `schema` | manifest JSON, the manifest schema | Manifest is present when supplied and validates, including baseline and versioning fields and ecommerce quality-bar metadata. | `path`, `errorCount`, `errors` |
| `storyboard` | `styleConcept.storyboard`, `styleGaps[]` | Inspiration pages explain each source page's role, the uncovered-element policy is present, and unresolved gaps have owner or reviewer metadata. | `inspirationCount`, `sourcePagesMissingInspiration`, `openStyleGapCount`, `problems` |
| `theme` | `themes[]`, public theme CSS | Exactly one `role: "current"` theme exists, each theme has id, version and path, referenced CSS exists, and the manifest hash matches disk. | `currentCount`, `switchableCount`, `problemCount`, `problems` |
| `css` | `content/home.html`, `content/pages-html/**/*.html`, linked stylesheets | At least one page is inspected, max inline CSS bytes per page is at or under `SM_INLINE_CSS_MAX_BYTES` (default 4096), duplicate normalized rule ratio is at or under `SM_CSS_DUPLICATE_RATIO_MAX` (default 0.25), and at least one shared stylesheet is linked. | `inlineCssBytesPerPageMax`, `duplicateRuleRatio`, `sharedStylesheetCount` |
| `readability` | HTML, inline CSS, linked CSS | Long-line ratio, minified-line ratio, CSS declaration density and large-stylesheet section comments stay within thresholds. | `issueCount`, `issueSamples`, `maxLineLength`, `cssDeclarationDensityMax` |
| `styleConcept` | `styleConcept`, `pages[]`, public stylesheet | Concept id exists, stylesheet hash matches disk, and tracked pages match the current concept id, version and stylesheet hash. | `id`, `version`, `pagesTracked`, `pagesConforming`, `pagesDrifted` |
| `styleGuide` | `styleGuideIndex`, `styleGuides[]`, `themes[]` | Preview-only index exists, is `noindex` and sitemap-excluded, links every recorded theme, every theme has a standalone guide, and at least one current-theme guide is `approved`. | `indexRoute`, `approvedCurrentCount`, `themesMissingStandaloneGuide`, `problems` |
| `manifestConventions` | manifest stylesheet path and hash fields | Stylesheet paths are root-relative public paths (`/tenants/<store-id>/...`), and hashes are raw lowercase 64-character SHA-256 hex without a `sha256:` prefix. | `problemCount`, `problems`, `notes` |
| `tokenContrast` | current theme `:root` variables plus descriptor role text | Text-role tokens resolve to colors and meet their declared background contrast: at least 4.5:1 for normal text, at least 3:1 for large, icon, focus and decorative roles; background tokens claiming white text prove white-on-token contrast of at least 4.5:1. | `problemCount`, `problems`, `currentThemeRecords` |
| `guideCoverage` | current theme CSS, descriptor tokens, standalone guide source | Every declared text-role token has a rendered guide sample using a selector colored by that token, and the expected ecommerce components are represented. | `problemCount`, `problems`, `currentThemeRecords` |
| `acceptedRisks` | `acceptedRisks[]`, `ecommerceQualityBar.acceptedRisks[]` | None exist, or each has `gate`, `rationale`, `by` and `at`. | `count`, `problemCount`, `problems` |
| `ecommerceStyleGuide` | `ecommerceQualityBar`, current theme CSS, descriptor JSON | Quality bar status is `approved`, and every current theme satisfies the static checks below. | `requiredVersion`, `status`, `problemCount`, `currentThemeRecords` |

### Ecommerce quality bar (v1.1) static checks

| Requirement | Detection contract |
| --- | --- |
| `token-contrast` | Parses current theme `:root` custom properties, resolves `var(...)` chains, reads descriptor role text, and checks text-safe tokens against the declared page, card and dark backgrounds using WCAG contrast math. |
| `guide-coverage` | Reads the standalone guide source, traces descriptor text-role tokens to theme `color: var(--token)` selectors, and requires matching samples plus CTA, form, rating, testimonial, trust, reassurance, logo, proof and card components. |
| `semantic-tokens` | Finds semantic token names in theme CSS or descriptor JSON: `--color-cta` or `--cta`, `--color-cta-hover` or `--cta-hover`, `--color-trust` or `--trust`, `--focus-ring`, `--color-error` or `--error`, `--color-success` or `--success`, `--surface-card` or `--surface-raised`, `--text-muted` or `--muted`. |
| `full-interactive-states` | Finds CSS or content evidence for `:hover`, `:active` or `[aria-pressed]`, `:focus-visible`, disabled, loading or busy, validation, help, success and error states, and `prefers-reduced-motion`. |
| `cta-hierarchy` | Finds primary, secondary and tertiary CTA evidence through button class names, token names, or explicit guide text. |
| `trust-social-proof-components` | Finds boundary-safe slots for proof and trust, reviews and ratings, testimonial or quote, badge, security or compliance, guarantee, returns, refund, warranty, and logo-strip patterns. These slots never authorize fabricated claims. |
| `accessible-forms` | Finds form fields plus label or ARIA labeling, help or `aria-describedby`, and required, optional, error, success and invalid states. |
| `mobile-tap-targets-and-fonts` | Finds responsive rules through `@media (max-width...)` or `clamp(...)`, plus tap-target evidence such as `44px` or `min-height` and `min-width` of at least 44px. Browser validation provides actual mobile and tiny-text samples. |
| `color-scheme-and-reduced-motion` | Finds `color-scheme` and `prefers-reduced-motion` evidence in the current theme CSS. |

## The ecommerce-grade bar (v1.1)

Track this bar as an enhanced concept version after a faithful baseline is approved.

- **Accessibility as conversion:** WCAG 2.2 AA contrast for text and controls; visible
  `:focus-visible` rings; keyboard flow through nav, CTAs, forms and proof components; reduced-motion
  parity.
- **Computed token contrast:** text-role tokens declared in the theme descriptor meet their stated role
  before page use, which catches sub-AA token values even when the guide has not rendered that token.
- **Guide coverage:** every declared text-role token and expected ecommerce component appears in the
  standalone guide, so browser accessibility and mobile gates exercise the real look.
- **Mobile-first ergonomics:** no horizontal overflow at 360-390px; body text generally 16px or more
  and no meaningful text under 14px; interactive targets at least 44px in both dimensions.
- **Performance budget:** mobile Lighthouse performance at least as good as the captured source
  baseline for launch pages (parity, not a fixed score). Preview-only guide routes are gated on
  accessibility and mobile, not performance. Guide examples should document LCP under 2.5s, CLS under
  0.1 and low TBT. Animations use `requestAnimationFrame`, pause off-screen and honor reduced motion.
- **Trust and social-proof components:** reusable, boundary-safe patterns for testimonials, ratings,
  security and compliance badges, sourced guarantees and logo strips. Claims stay placeholders or
  `needs-review` until sourced.
- **Semantic tokens:** promote raw palette names into aliases such as `--color-cta`,
  `--color-cta-hover`, `--color-trust`, `--focus-ring`, `--color-error`, `--color-success`,
  `--surface-card` and `--text-muted` so reskins preserve intent.
- **Full interactive states:** hover, active, focus-visible, disabled, loading or busy, selected or
  current, error, success, help and reduced-motion.
- **Accessible forms:** labels, help text, required and optional markers, validation errors, success
  messages, disabled and loading states.
- **CTA hierarchy:** one primary treatment, clear secondary and tertiary treatments, contrast-checked
  states, and usage rules for hero, nav, pricing, footer and mobile sticky CTAs.
- **Color-scheme readiness:** declare an intentional `color-scheme`; document whether the theme is
  light-only, dark-only or paired.

A `v1.1` guide is not marked approved until the style gates pass, preview accessibility and mobile
pass, live-page performance passes or is covered by a structured accepted risk, and the readiness page
explains any accepted risk.

## Style guide checks

Preview-only guide routes are gated on accessibility and mobile only; Lighthouse performance, SEO,
CSP, pixel parity and console gates are skipped or advisory there, because preview and noindex surfaces
produce noise that does not apply to launch pages. Every guide route must be `noindex`, preview-only
and excluded from the sitemap, and the index must link to every recorded theme guide.

## Site-wide use

For site-wide propagation, client approval and sign-off of the guide, and the reusable-component
harvest loop, see the Agency Kit's style-concept playbook.
