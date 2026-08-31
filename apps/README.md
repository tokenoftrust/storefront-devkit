# Apps

Use this track when you are building software that connects to a Storefront tenant, rather than
customizing the tenant's theme, content, or sandboxed scripts.

This is the public developer entry point for Storefront apps. It is documentation and
contract-oriented: an app is your independently hosted service, in the language and framework you
choose. The devkit does not ship an npm package or platform runtime.

## Available now: private apps

[Private apps](../private-apps/) connect one merchant tenant to your service through the
standards-based private-app contract. Use them for backend integrations such as catalog, order, or
inventory synchronization; signed lifecycle webhooks; app-owned records; and approved app UI
placements.

Start with [the private-app guide](../private-apps/README.md). Together with this page, it is the
canonical public documentation for the current app-developer path: orientation, boundaries, and
links that are safe to share with developers and coding agents. Detailed publicly releasable
contract material will be added here in a separate cutover; do not fill that gap with platform
source or inferred APIs.

`private-apps/` remains the stable, direct URL for this current guide. This `apps/` directory is
the broader front door; links to the existing private-app material are intentionally not broken.

## Reserved: public apps

Public apps are not available today. This directory reserves a clear place for that future product
without making capability, availability, installation, or review-process claims in advance.

Until that product exists, build only against the documented private-app contract. Do not infer a
public-app API, marketplace, distribution channel, or approval flow from this repository.

## Choose the right path

| Need | Start here |
|---|---|
| Brand, configure, or compose a merchant storefront | [Templates, schemas, and recipes](../README.md) |
| Add a small merchant-owned interactive enhancement | [Sandboxed widgets](../widgets/README.md) |
| Connect your service to one merchant tenant | [Private apps](../private-apps/README.md) |
| Build a public app | Not available; do not assume an interface exists |

## Documentation authority

For public documentation and LLM use, this GitHub repository is canonical. Use GitHub-relative
paths—starting with [`apps/`](./) and [`private-apps/`](../private-apps/)—rather than treating an
MCP recipe as the authority. `recipe://storefront-private-apps-devbook` is a discovery pointer and
index to this material; it does not supersede the repository.

This public material does not copy platform source, private APIs, secrets, or implementation
internals. A later cutover will add the detailed, public contract corpus here without changing that
boundary.
