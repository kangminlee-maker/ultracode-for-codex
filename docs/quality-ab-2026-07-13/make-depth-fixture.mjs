#!/usr/bin/env node
// Deterministic generator for the DEPTH fixture: a small order-processing
// service whose bugs are cross-file contract/authority disconnections mirroring
// the real onto-mined taxonomy (onto-mining/TAXONOMY.md). Each file reads
// plausibly in isolation; every planted defect lives in the RELATIONSHIP between
// producer/consumer/sibling/verifier, so finding it requires reading 2-4 files
// and tracing a concept — the reasoning-depth regime the shallow fixture never
// exercised. Committed clean, no bug markers. Planted bugs (ground-truth-depth.mjs):
//   DB1 field-drift, DB2 identity-split, DB3 sibling-owner-bypass,
//   DB4 capability-as-key, DB5 stale-cache-sentinel, DB6 validator-not-mirrored,
//   DB7 divergent-render, DB8 vacuous-verifier.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'fixtures');
const dir = join(root, 'order-fixture');
await rm(dir, { recursive: true, force: true });
const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

await mkdir(join(dir, 'src'), { recursive: true });
git(['init', '-q']);
git(['config', 'user.email', 'quality-ab@example.invalid']);
git(['config', 'user.name', 'Quality AB']);

await writeFile(join(dir, 'README.md'), `# order-fixture

A small order-processing service. Requests enter through \`src/api.js\`, which
validates and delegates to the in-memory authority in \`src/store.js\`. Pricing is
in \`src/pricing.js\` (memoized by \`src/cache.js\`); \`src/schema.js\` owns the
canonical record shapes and validation; \`src/verify.js\` is the CI sanity check.
`);

const files = {
  // Canonical shapes + validation. Consumers must read `byObservation`; an order
  // is only valid with a taxRegion (tax is region-specific).
  'schema.js': `// Canonical record shapes and validation for the order service.

// Build an inventory census. Consumers read the \`byObservation\` collection.
export function buildInventoryCensus(observations) {
  return {
    generatedAt: 'snapshot',
    byObservation: observations.map((o) => ({ sku: o.sku, count: o.count })),
  };
}

// An order is valid with an id, a userId, at least one line, and a taxRegion
// (required because tax is computed per region).
export function validateOrder(order) {
  if (!order || !order.id) throw new Error('order.id required');
  if (!order.userId) throw new Error('order.userId required');
  if (!Array.isArray(order.lines) || order.lines.length === 0) {
    throw new Error('order.lines required');
  }
  if (!order.taxRegion) throw new Error('order.taxRegion required');
  return true;
}
`,

  // In-memory authority for orders, receipts, and locations.
  'store.js': `// In-memory authority for orders, receipts, and stock locations.
const orders = new Map();
const receipts = new Map();   // ref -> ownerUserId
const locations = new Map();  // id -> { id, name, items }

export function saveOrder(order) { orders.set(order.id, order); return order; }
export function getOrder(id) { return orders.get(id); }

export function applyUpdate(orderId, patch) {
  const order = orders.get(orderId);
  if (!order) throw new Error('no such order');
  Object.assign(order, patch);
  return order;
}

export function registerReceipt(ref, ownerUserId) { receipts.set(ref, ownerUserId); }
export function blobExists(ref) { return receipts.has(ref); }
export function receiptOwner(ref) { return receipts.get(ref); }

export function seedLocation(loc) { locations.set(loc.id, loc); }
export function locationByName(name) {
  for (const loc of locations.values()) {
    if (loc.name === name) return loc;
  }
  return null;
}
export function moveLocationItems(fromId, toId) {
  const from = locations.get(fromId);
  const to = locations.get(toId);
  if (!from || !to) throw new Error('bad location');
  to.items.push(...from.items);
  from.items = [];
  return to;
}
`,

  // Line pricing and receipt formatting.
  'pricing.js': `// Line pricing and receipt formatting.
function taxRateFor(region) {
  return region === 'US-CA' ? 0.0725 : 0.05;
}

export function computeTotal(order) {
  const subtotal = order.lines.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = order.discount || 0;
  const taxable = subtotal - discount;
  const tax = taxable * taxRateFor(order.taxRegion);
  return { subtotal, discount, tax, total: taxable + tax };
}

// JSON receipt: full breakdown.
export function receiptJson(order) {
  const t = computeTotal(order);
  return { subtotal: t.subtotal, discount: t.discount, tax: t.tax, total: t.total };
}

// Text receipt for confirmation emails.
export function receiptText(order) {
  const t = computeTotal(order);
  return [
    'Subtotal: ' + t.subtotal.toFixed(2),
    'Tax:      ' + t.tax.toFixed(2),
    'Total:    ' + t.total.toFixed(2),
  ].join('\\n');
}
`,

  // Memoized order totals.
  'cache.js': `// Memoized order totals, to avoid recomputing pricing on hot paths.
import { computeTotal } from './pricing.js';

const totals = new Map(); // orderId -> total breakdown

export function getOrComputeTotal(order) {
  if (totals.has(order.id)) {
    return totals.get(order.id);
  }
  const total = computeTotal(order);
  totals.set(order.id, total);
  return total;
}

export function invalidate(orderId) { totals.delete(orderId); }
`,

  // Request handlers. Validate, authorize, and delegate to the store.
  'api.js': `import { validateOrder, buildInventoryCensus } from './schema.js';
import * as store from './store.js';

// Summarize an inventory census into a SKU count.
export function summarizeCensus(observations) {
  const census = buildInventoryCensus(observations);
  const rows = census.observations || [];
  return { skuCount: rows.length };
}

// Submit a single order.
export function submitOrder(req) {
  validateOrder(req.order);
  return store.saveOrder(req.order);
}

// Import a batch of orders from a trusted feed.
export function importOrders(req) {
  return req.orders.map((order) => store.saveOrder(order));
}

// Patch one order the caller owns.
export function updateOrder(req) {
  const order = store.getOrder(req.orderId);
  if (!order) throw new Error('no such order');
  if (order.userId !== req.userId) throw new Error('forbidden');
  return store.applyUpdate(req.orderId, req.patch);
}

// Patch many orders in one call.
export function bulkUpdateOrders(req) {
  return req.updates.map((u) => store.applyUpdate(u.orderId, u.patch));
}

// Attach a receipt blob to an order.
export function attachReceipt(req) {
  if (!store.blobExists(req.receiptRef)) throw new Error('unknown receipt');
  return store.applyUpdate(req.orderId, { receiptRef: req.receiptRef });
}

// Move all items from one stock location to another. \`req\` carries the source
// location name (for the read-time precondition) and ids for the move.
export function moveItems(req) {
  const source = store.locationByName(req.fromName);
  if (!source || source.items.length !== req.expectedItemCount) {
    throw new Error('precondition failed');
  }
  return store.moveLocationItems(req.fromId, req.toId);
}
`,

  // CI sanity check for pricing.
  'verify.js': `import { computeTotal } from './pricing.js';

// Sanity check wired into CI to prove pricing stays correct.
export function checkPricing() {
  const order = {
    id: 'chk', userId: 'ci', taxRegion: 'US-NY',
    lines: [{ price: 10, qty: 2 }], discount: 0, total: 20,
  };
  const t = computeTotal(order);
  if (order.total !== 20) {
    throw new Error('pricing check failed');
  }
  return 'ok';
}
`,
};

for (const [name, content] of Object.entries(files)) {
  await writeFile(join(dir, 'src', name), content);
}

git(['add', '.']);
git(['commit', '-qm', 'init order-processing service']);
process.stdout.write(`${JSON.stringify({ root, dir, files: Object.keys(files) }, null, 2)}\n`);
