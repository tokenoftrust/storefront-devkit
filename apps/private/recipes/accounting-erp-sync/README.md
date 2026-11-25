# Accounting & ERP Invoice Sync Connector Recipe (QuickBooks Online, Xero & NetSuite)

This self-contained, zero-dependency reference recipe shows how an external accounting or ERP connector
(**QuickBooks Online (`QBO`)**, **Xero (`XERO`)**, or **NetSuite (`NS`)**) integrates with Storefront
Private Apps (`private-apps@1.7`):

1. **Verifies & deduplicates inbound invoice webhooks** (`order.invoiced` and `invoice.settled`,
   scope `orders:webhook`) using the vendored [`connector-kit`](../../../../packages/connector-kit/)
   `WebhookReceiver` (RFC 9530 `Content-Digest`, RFC 9421 `rsa-v1_5-sha256` signature, and
   at-least-once CloudEvents `id` replay protection).
2. **Hydrates the install-scoped order and `Order.invoice` metadata** via
   `GET /api/apps/v1/orders/{id}` (`orders:read-minimal`), obtaining the install's opaque
   `customerHash` without ever receiving raw customer PII, purchase-order numbers, or internal notes.
3. **Maps the canonical invoice and settlement state** through plug-in adapters (`ERP_ADAPTERS.QBO`,
   `ERP_ADAPTERS.XERO`, `ERP_ADAPTERS.NS`), including line items, freight (`total - subtotal`),
   net-terms days, due dates, and settlement mode (`net_terms`, `offline_transfer`, `foxy_pay_link`).
4. **Writes back the external accounting reference** (`externalAccountingRef`, e.g.
   `QBO:INV-000104`, `XERO:INV-000104`, or `NS:INV-000104`) to the order via
   `POST /api/apps/v1/orders/{id}/accounting-ref` (`orders:write-accounting-ref`) with a
   deterministic `Idempotency-Key` (`deriveIdempotencyKey`), verifying `200` idempotent replay and
   `409` conflict handling (`idempotency_conflict` / `accounting_ref_conflict`).

## Run the self-test & unit suite

```bash
node index.mjs --self-test
node --test test/*.test.mjs
```

## Least-privilege scopes (`tot-app.json`)

| Scope | Purpose |
|---|---|
| `orders:read-minimal` | Read `GET /orders` and `GET /orders/{id}`, including `customerHash` and `Order.invoice`. |
| `orders:webhook` | Receive signed `order.invoiced` and `invoice.settled` CloudEvents. |
| `orders:write-accounting-ref` | Record or idempotently replay `externalAccountingRef` on an issued, paid, or voided manual-invoice order (`POST /orders/{id}/accounting-ref`). |

## Architecture & compliance boundary

- **Native vs. App Territory (ADR 0045):** Storefront natively owns B2B manual/phone order entry,
  1-click bulk quote conversion, invoice number sequencing (`INV-xxxxxx`), compliance/KYB release
  gates, and PACT monthly close packets. External accounting/ERP synchronization (QuickBooks Online,
  Xero, NetSuite) lives in **Private App territory** over this public contract.
- **Data minimization:** Neither `order.invoiced`, `invoice.settled`, `GET /orders/{id}`, nor
  `POST /orders/{id}/accounting-ref` ever carries raw customer contact PII, purchase-order numbers,
  free-text notes, or settlement references. The connector joins on `orderId` and keys customer
  accounts in the ERP by the install-scoped `customerHash`.
