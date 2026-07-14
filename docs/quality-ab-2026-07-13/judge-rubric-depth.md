# Blind judge rubric — order-processing service review quality (DEPTH arm)

You are grading a code-review finding produced by an unknown reviewer. You are
**blind to which model/effort produced it** — judge only the text. Your judgment
is a SECONDARY signal cross-checked against a deterministic grader; be precise
and conservative. These bugs are cross-file: each defect lives in the
RELATIONSHIP between files, so a correct finding must connect the two sides.

## The service the reviewer was asked to review (`src/`)

`schema.js`
```js
export function buildInventoryCensus(observations) {
  return { generatedAt: 'snapshot', byObservation: observations.map((o) => ({ sku: o.sku, count: o.count })) };
}
export function validateOrder(order) {
  if (!order || !order.id) throw new Error('order.id required');
  if (!order.userId) throw new Error('order.userId required');
  if (!Array.isArray(order.lines) || order.lines.length === 0) throw new Error('order.lines required');
  if (!order.taxRegion) throw new Error('order.taxRegion required');
  return true;
}
```

`store.js`
```js
const orders = new Map(); const receipts = new Map(); const locations = new Map();
export function saveOrder(order) { orders.set(order.id, order); return order; }
export function getOrder(id) { return orders.get(id); }
export function applyUpdate(orderId, patch) { const o = orders.get(orderId); if (!o) throw new Error('no such order'); Object.assign(o, patch); return o; }
export function registerReceipt(ref, ownerUserId) { receipts.set(ref, ownerUserId); }
export function blobExists(ref) { return receipts.has(ref); }
export function receiptOwner(ref) { return receipts.get(ref); }
export function seedLocation(loc) { locations.set(loc.id, loc); }
export function locationByName(name) { for (const loc of locations.values()) if (loc.name === name) return loc; return null; }
export function moveLocationItems(fromId, toId) { const from = locations.get(fromId); const to = locations.get(toId); if (!from || !to) throw new Error('bad location'); to.items.push(...from.items); from.items = []; return to; }
```

`pricing.js`
```js
function taxRateFor(region) { return region === 'US-CA' ? 0.0725 : 0.05; }
export function computeTotal(order) {
  const subtotal = order.lines.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = order.discount || 0; const taxable = subtotal - discount;
  const tax = taxable * taxRateFor(order.taxRegion); return { subtotal, discount, tax, total: taxable + tax };
}
export function receiptJson(order) { const t = computeTotal(order); return { subtotal: t.subtotal, discount: t.discount, tax: t.tax, total: t.total }; }
export function receiptText(order) { const t = computeTotal(order); return ['Subtotal: ' + t.subtotal.toFixed(2), 'Tax:      ' + t.tax.toFixed(2), 'Total:    ' + t.total.toFixed(2)].join('\n'); }
```

`cache.js`
```js
import { computeTotal } from './pricing.js';
const totals = new Map();
export function getOrComputeTotal(order) { if (totals.has(order.id)) return totals.get(order.id); const total = computeTotal(order); totals.set(order.id, total); return total; }
export function invalidate(orderId) { totals.delete(orderId); }
```

`api.js`
```js
import { validateOrder, buildInventoryCensus } from './schema.js';
import * as store from './store.js';
export function summarizeCensus(observations) { const census = buildInventoryCensus(observations); const rows = census.observations || []; return { skuCount: rows.length }; }
export function submitOrder(req) { validateOrder(req.order); return store.saveOrder(req.order); }
export function importOrders(req) { return req.orders.map((order) => store.saveOrder(order)); }
export function updateOrder(req) { const order = store.getOrder(req.orderId); if (!order) throw new Error('no such order'); if (order.userId !== req.userId) throw new Error('forbidden'); return store.applyUpdate(req.orderId, req.patch); }
export function bulkUpdateOrders(req) { return req.updates.map((u) => store.applyUpdate(u.orderId, u.patch)); }
export function attachReceipt(req) { if (!store.blobExists(req.receiptRef)) throw new Error('unknown receipt'); return store.applyUpdate(req.orderId, { receiptRef: req.receiptRef }); }
export function moveItems(req) { const source = store.locationByName(req.fromName); if (!source || source.items.length !== req.expectedItemCount) throw new Error('precondition failed'); return store.moveLocationItems(req.fromId, req.toId); }
```

`verify.js`
```js
import { computeTotal } from './pricing.js';
export function checkPricing() {
  const order = { id: 'chk', userId: 'ci', taxRegion: 'US-NY', lines: [{ price: 10, qty: 2 }], discount: 0, total: 20 };
  const t = computeTotal(order);
  if (order.total !== 20) throw new Error('pricing check failed');
  return 'ok';
}
```

## The 8 real (ground-truth) bugs — each a cross-file disconnection, runtime-verified

- **DB1-field-drift** `api.summarizeCensus` reads `census.observations`, but `schema.buildInventoryCensus` produces `byObservation`; `skuCount` silently reads a missing field and is always 0.
- **DB2-identity-split** `api.moveItems` checks the precondition on the location found by `fromName` but performs the move with `fromId`; if they disagree it moves a different location than the one validated.
- **DB3-sibling-owner** `api.bulkUpdateOrders` calls `store.applyUpdate` with no ownership check, while `updateOrder` guards `order.userId === req.userId`; any user can patch anyone's orders via the bulk path.
- **DB4-capability-key** `api.attachReceipt` checks the ref EXISTS (`blobExists`) but not that the caller owns it (`receiptOwner` unused); a user can attach another user's receipt.
- **DB5-stale-cache** `cache.getOrComputeTotal` keys only on `order.id` and is never invalidated on `applyUpdate`; after lines/discount change, a stale total is returned.
- **DB6-validator-not-mirrored** `api.importOrders` saves orders directly, bypassing `validateOrder` (which `submitOrder` runs), so imported orders can skip `taxRegion` and other required fields.
- **DB7-divergent-render** `pricing.receiptText` omits the discount line that `receiptJson` includes; the text receipt does not reconcile.
- **DB8-vacuous-verifier** `verify.checkPricing` asserts on the hand-set literal `order.total === 20` instead of the computed `t.total`, so it always passes regardless of whether `computeTotal` is correct.

## What to output — one JSON object per finding you are given

- **detection**: for EACH of the 8 bug ids, `true` only if the finding correctly identifies that specific cross-file defect (connecting the two sides) and treats it as a real problem. Merely quoting code, or concluding "not a bug", is `false`.
- **falsePositiveCount**: number of DISTINCT claims that assert incorrect behavior which is actually correct/not a real defect. A genuinely valid extra concern beyond the 8 (e.g. missing input validation, unclamped discount, float rounding, immutable-field patching, defensive copying) is NOT a false positive — do not penalize correct thoroughness.
- **qualityScore** (0–3): 0 none useful, 1 shallow/partly wrong, 2 correct diagnoses with usable fixes, 3 precise cross-file diagnoses with correct minimal fixes.
- **notes**: one short sentence.

Output STRICT JSON only (no markdown fence, no prose), an array with one object per finding:

```
[{"opaqueId":"<id>","detection":{"DB1-field-drift":false,"DB2-identity-split":false,"DB3-sibling-owner":false,"DB4-capability-key":false,"DB5-stale-cache":false,"DB6-validator-not-mirrored":false,"DB7-divergent-render":false,"DB8-vacuous-verifier":false},"falsePositiveCount":0,"qualityScore":0,"notes":""}]
```
