#!/usr/bin/env node
// Deterministic fixture generator for the medium/high/xhigh quality A/B.
// Creates one committed git repo <root>/cart-fixture with a plausible shopping
// cart / inventory module carrying the 7 planted bugs enumerated in
// ground-truth.mjs. The module is COMMITTED (clean tree) so the built-in `task`
// reads it as ordinary source, matching the W3 task-fixture setup. The code
// carries no bug markers: a reviewer has to find each defect on its merits.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'fixtures');
const dir = join(root, 'cart-fixture');
await rm(dir, { recursive: true, force: true });

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

await mkdir(join(dir, 'src'), { recursive: true });
git(dir, ['init', '-q']);
git(dir, ['config', 'user.email', 'quality-ab@example.invalid']);
git(dir, ['config', 'user.name', 'Quality AB']);

await writeFile(join(dir, 'README.md'), `# cart-fixture

Pricing and inventory helpers for a small storefront. \`src/cart.js\` holds the
money and stock logic used by the checkout flow.
`);

// The module under review. Realistic, self-contained, no bug annotations. Every
// planted defect is DEFINITE (wrong under any reasonable contract). See
// ground-truth.mjs: B1 applyDiscount sign, B2 paginate index base, B3
// qualifiesForFreeShipping boundary, B4 cartTotal reduce-no-initial, B5
// sortByPriceAsc boolean comparator, B6 removeOutOfStock splice-in-forEach, B7
// fetchPrices async race, B8 finalPrice operator precedence.
await writeFile(join(dir, 'src', 'cart.js'), `// Pricing and inventory helpers for the checkout flow.

// Apply a percentage discount to a unit price.
// \`percent\` is a whole number, e.g. 20 means 20% off.
export function applyDiscount(price, percent) {
  return price + (price * percent) / 100;
}

// Return one page of items. \`page\` is 1-indexed; \`size\` is the page length.
export function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

// Orders of $50 or more ship free.
export function qualifiesForFreeShipping(total) {
  return total > 50;
}

// Sum the charge for a cart of line items ({ price, qty }).
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty);
}

// Return the items sorted by ascending unit price (does not mutate the input).
export function sortByPriceAsc(items) {
  return items.slice().sort((a, b) => a.price > b.price);
}

// Drop every item whose stock has reached zero; returns the remaining items.
export function removeOutOfStock(items) {
  items.forEach((item, i) => {
    if (item.stock === 0) {
      items.splice(i, 1);
    }
  });
  return items;
}

// Look up the current price for each id via the pricing API.
export async function fetchPrices(ids, api) {
  const prices = {};
  ids.forEach(async (id) => {
    prices[id] = await api.getPrice(id);
  });
  return prices;
}

// Charge for one line: take the coupon off the price, then add sales tax on the
// remaining amount. \`taxRate\` is a fraction, e.g. 0.08 for 8%.
export function finalPrice(price, couponOff, taxRate) {
  return price - couponOff * (1 + taxRate);
}
`);

// A consumer file so the module reads as part of a real repo, not a lone
// snippet. This code is correct; it only exercises the helpers.
await writeFile(join(dir, 'src', 'checkout.js'), `import { applyDiscount, qualifiesForFreeShipping, cartTotal, finalPrice } from './cart.js';

export function lineTotal(unitPrice, quantity, discountPercent) {
  const discounted = applyDiscount(unitPrice, discountPercent);
  return discounted * quantity;
}

export function shippingFee(orderTotal) {
  return qualifiesForFreeShipping(orderTotal) ? 0 : 5.99;
}

export function orderSummary(items, couponOff, taxRate) {
  const subtotal = cartTotal(items);
  return {
    subtotal,
    charged: finalPrice(subtotal, couponOff, taxRate),
    shipping: shippingFee(subtotal),
  };
}
`);

git(dir, ['add', '.']);
git(dir, ['commit', '-qm', 'init cart pricing and inventory helpers']);

process.stdout.write(`${JSON.stringify({ root, dir }, null, 2)}\n`);
