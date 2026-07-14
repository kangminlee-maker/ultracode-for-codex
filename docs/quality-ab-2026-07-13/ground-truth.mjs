// Ground-truth bug set + deterministic detection signatures for the
// medium/high/xhigh comparative QUALITY A/B (2026-07-13).
//
// The fixture module (make-fixture.mjs writes src/cart.js) carries exactly these
// 8 planted bugs. Every bug is DEFINITE — incorrect under any reasonable
// contract — so a competent review confirms it rather than hedging it as a
// contract-dependent risk. (An N=1 calibration on an earlier, easier set showed
// two failure modes: a 100% ceiling on textbook bugs, and models correctly
// DECLINING contract-dependent "bugs" like input mutation while a location-only
// signature miscounted the mention as a detection. Both are removed here:
// definite bugs give a clean "mention == correct detection" recall and enough
// difficulty headroom to expose any tier gap.)
//
// The code carries NO bug markers. Detection is deterministic (PRIMARY signal):
// a bug counts as found when the run's final result text matches BOTH nameRe
// (location: function name or a distinctive phrase) AND symptomRe (the specific
// defect). The blind LLM judge is a separate SECONDARY signal (false positives +
// confirmed-vs-hedged nuance + fix quality); the decision rests on this
// deterministic recall, never on the unconfirmed judge.

export const BUGS = [
  {
    id: 'B1-sign',
    fn: 'applyDiscount',
    class: 'sign/direction',
    difficulty: 'easy',
    desc: 'applyDiscount adds the discount instead of subtracting it (price goes up).',
    nameRe: /applyDiscount|discount/i,
    symptomRe: /(subtract|minus|sign|adds instead|increases? the price|should reduce|wrong direction|raises? the price|higher price|price goes up|inflat|\bplus\b instead)/i,
  },
  {
    id: 'B2-index',
    fn: 'paginate',
    class: 'index-base/off-by-one',
    difficulty: 'medium',
    desc: 'paginate treats a 1-indexed page as 0-indexed (start = page*size), skipping the first page.',
    nameRe: /paginate|pagination/i,
    symptomRe: /(off.?by.?one|1-?index|one-?index|zero-?index|first page|skips? the first|page\s*[-*]\s*(1|size)|\(page\s*-\s*1\)|starts? at the wrong|one page (?:too )?far)/i,
  },
  {
    id: 'B3-boundary',
    fn: 'qualifiesForFreeShipping',
    class: 'boundary-comparison',
    difficulty: 'subtle',
    desc: 'qualifiesForFreeShipping uses total > 50, excluding an order of exactly $50 that should qualify (should be >=).',
    nameRe: /qualifiesForFreeShipping|free.?shipping/i,
    symptomRe: /(>=|greater than or equal|exactly (?:\$)?50|equal to (?:\$)?50|inclusive|boundary|edge case|off.?by.?one|excludes? (?:\$)?50|at (?:\$)?50|should (?:include|qualify)|strict(?:ly)? greater|equality)/i,
  },
  {
    id: 'B4-reduce',
    fn: 'cartTotal',
    class: 'reduce-missing-initial-value',
    difficulty: 'hard',
    desc: 'cartTotal calls reduce with no initial value, so the first item object becomes the accumulator (wrong total / NaN / string concat).',
    nameRe: /cartTotal/i,
    symptomRe: /(initial value|initial accumulator|seed|no initial|missing.*initial|without an? initial|second argument|starts? (?:with|as|from) the first|first (?:item|element).*(?:accumulat|initial|seed)|omits? the first|\bNaN\b|\[object Object\]|reduce\([^)]*\)\s*(?:with no|without|lacks)|, 0\))/i,
  },
  {
    id: 'B5-comparator',
    fn: 'sortByPriceAsc',
    class: 'sort-comparator-boolean',
    difficulty: 'subtle',
    desc: 'sortByPriceAsc comparator returns a boolean (a.price > b.price) instead of a number, giving incorrect/unstable ordering.',
    nameRe: /sortByPriceAsc|comparator|\.sort\(/i,
    symptomRe: /(boolean|return (?:a )?number|must return|-1|0, or 1|a\.price\s*-\s*b\.price|subtract|compare function|true\/false|true or false|coerce|not a valid comparator|unstable|non-?numeric)/i,
  },
  {
    id: 'B6-splice',
    fn: 'removeOutOfStock',
    class: 'mutate-while-iterating',
    difficulty: 'hard',
    desc: 'removeOutOfStock splices during forEach, so it skips the element after each removal (adjacent zero-stock items survive).',
    nameRe: /removeOutOfStock/i,
    symptomRe: /(splice.*(?:forEach|iterat|loop|while)|during iteration|skips?|index shift|shifts? the index|adjacent|iterate.*backw|reverse|use filter|filter\(|element after|consecutive|re-?index)/i,
  },
  {
    id: 'B7-async',
    fn: 'fetchPrices',
    class: 'async-race/lost-await',
    difficulty: 'hard',
    desc: 'fetchPrices uses forEach with an async callback and returns prices before any awaited value settles.',
    nameRe: /fetchPrices|forEach/i,
    symptomRe: /(not awaited|returns? before|race|Promise\.all|for(?:\.\.\.| )of|await(?:ed)?|async callback|forEach.*async|never (?:waits|resolved)|empty (?:object|result)|unresolved|detached|does not wait)/i,
  },
  {
    id: 'B8-precedence',
    fn: 'finalPrice',
    class: 'operator-precedence',
    difficulty: 'medium',
    desc: 'finalPrice computes price - couponOff * (1 + taxRate): precedence applies tax only to the coupon, not the discounted price (missing parentheses).',
    nameRe: /finalPrice/i,
    symptomRe: /(precedence|parenthes|order of operations|only.*coupon|tax (?:is )?(?:only )?applied (?:only )?to.*coupon|\(price\s*-\s*couponOff\)|price.*(?:not|isn.?t) taxed|untaxed|grouping|multiplication (?:is )?(?:done|applied|evaluated) (?:first|before)|couponOff \* \(1)/i,
  },
];

// A run's result text -> per-bug found booleans + recall.
export function gradeText(resultText) {
  const text = resultText == null ? '' : String(resultText);
  const perBug = BUGS.map((bug) => ({
    id: bug.id,
    found: bug.nameRe.test(text) && bug.symptomRe.test(text),
  }));
  const foundCount = perBug.filter((b) => b.found).length;
  return { perBug, foundCount, total: BUGS.length, recall: foundCount / BUGS.length };
}
