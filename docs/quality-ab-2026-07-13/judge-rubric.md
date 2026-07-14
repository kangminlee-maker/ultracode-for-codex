# Blind judge rubric — cart.js bug review quality

You are grading a code-review finding produced by an unknown reviewer. You are
**blind to which model/effort produced it** — judge only the text in front of
you. Your judgment is a SECONDARY signal cross-checked against a deterministic
grader; be precise and conservative.

## The module the reviewer was asked to review (`src/cart.js`)

```js
// Pricing and inventory helpers for the checkout flow.

export function applyDiscount(price, percent) {
  return price + (price * percent) / 100;
}

export function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

export function qualifiesForFreeShipping(total) {
  return total > 50;
}

export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty);
}

export function sortByPriceAsc(items) {
  return items.slice().sort((a, b) => a.price > b.price);
}

export function removeOutOfStock(items) {
  items.forEach((item, i) => {
    if (item.stock === 0) {
      items.splice(i, 1);
    }
  });
  return items;
}

export async function fetchPrices(ids, api) {
  const prices = {};
  ids.forEach(async (id) => {
    prices[id] = await api.getPrice(id);
  });
  return prices;
}

export function finalPrice(price, couponOff, taxRate) {
  return price - couponOff * (1 + taxRate);
}
```

## The 8 real (ground-truth) bugs

Each is a DEFINITE defect (wrong under any reasonable contract). All 8 were
independently verified to misbehave at runtime.

- **B1-sign** `applyDiscount`: adds the discount instead of subtracting; a
  positive discount raises the price (`applyDiscount(100,20)` → 120, not 80).
- **B2-index** `paginate`: `page` is documented 1-indexed but `start = page*size`
  treats it as 0-indexed, so page 1 skips the first `size` items.
- **B3-boundary** `qualifiesForFreeShipping`: uses `total > 50`, so exactly $50
  (which should qualify per "$50 or more") does not. Should be `>=`.
- **B4-reduce** `cartTotal`: `reduce` has no initial value, so the first item
  object becomes the accumulator; the total is wrong (string/NaN, first item's
  contribution mis-handled). Needs an initial value of `0`.
- **B5-comparator** `sortByPriceAsc`: the comparator returns a boolean
  (`a.price > b.price`) instead of a number; a sort comparator must return a
  number (`a.price - b.price`), so ordering is incorrect/unstable.
- **B6-splice** `removeOutOfStock`: `splice` inside `forEach` shifts indices, so
  the element after each removed one is skipped; adjacent zero-stock items
  survive. Needs `filter` or reverse iteration.
- **B7-async** `fetchPrices`: `forEach` with an async callback is not awaited, so
  the function returns `prices` before any lookup settles (empty/partial), and a
  rejected `getPrice` becomes a detached/unhandled rejection. Needs
  `Promise.all` / `for...of` with await.
- **B8-precedence** `finalPrice`: `price - couponOff * (1 + taxRate)` applies tax
  only to the coupon by operator precedence; intended is
  `(price - couponOff) * (1 + taxRate)`. Missing parentheses.

## What to output — one JSON object for the finding

For the finding text you are given, decide:

- **detection**: for EACH of the 8 bug ids, `true` only if the finding correctly
  identifies that specific defect AND treats it as a real problem to fix (a
  correct fix or clearly-correct diagnosis counts; merely quoting the code does
  not; explicitly concluding "not a bug" for that item is `false`).
- **falsePositiveCount**: the number of DISTINCT claims in the finding that
  assert incorrect behavior which is actually correct or not a real defect
  (wrong claims). A genuinely valid extra concern outside the 8 is NOT a false
  positive — do not penalize correct thoroughness; only count claims that are
  themselves wrong.
- **qualityScore** (0–3): overall quality of the real-bug findings — 0 none
  useful, 1 shallow/partly wrong, 2 correct diagnoses with usable fixes, 3
  precise diagnoses with correct, minimal fixes and relevant edge reasoning.
- **notes**: one short sentence.

Output STRICT JSON only (no prose, no markdown fence), an array with one object
per finding you were given:

```
[{"opaqueId":"<id>","detection":{"B1-sign":false,"B2-index":false,"B3-boundary":false,"B4-reduce":false,"B5-comparator":false,"B6-splice":false,"B7-async":false,"B8-precedence":false},"falsePositiveCount":0,"qualityScore":0,"notes":""}]
```
