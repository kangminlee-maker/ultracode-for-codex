// Ground-truth bug set + deterministic signatures for the DEPTH arm.
// Each bug is a cross-file contract/authority disconnection (see
// onto-mining/TAXONOMY.md); every one was runtime-verified to misbehave. A bug
// counts as found when the run's result text matches BOTH nameRe (the location)
// AND symptomRe (the relational defect). Because these defects are relational,
// the blind judge carries more of the signal here; the deterministic recall is
// the falsifiable floor. Signatures calibrated on real N<=2 output before the
// full batch.

export const BUGS = [
  {
    id: 'DB1-field-drift',
    fn: 'summarizeCensus',
    family: 'field/alias drift',
    difficulty: 'medium',
    desc: 'api.summarizeCensus reads census.observations, but schema.buildInventoryCensus produces `byObservation`; the count silently reads a missing field and is always 0.',
    nameRe: /summarizeCensus|buildInventoryCensus|census/i,
    symptomRe: /(byobservation[\s\S]{0,80}\bobservations\b|\bobservations\b[\s\S]{0,80}byobservation|wrong (field|key|property)|field (name )?mismatch|renamed|drift|missing field|undefined field|reads? (a )?(missing|wrong|nonexistent)|census\.observations|silently (0|zero|empty)|always (0|zero|empty)|skuCount)/i,
  },
  {
    id: 'DB2-identity-split',
    fn: 'moveItems',
    family: 'authority/identity split',
    difficulty: 'hard',
    desc: 'api.moveItems checks the precondition on the location found by fromName but performs the move using fromId; if they disagree it moves a different location than the one validated.',
    nameRe: /moveItems|moveLocationItems/i,
    symptomRe: /(fromname[\s\S]{0,90}fromid|fromid[\s\S]{0,90}fromname|by name[\s\S]{0,90}by id|precondition[\s\S]{0,90}(different|another|mismatch|not the same|id)|checks?[\s\S]{0,60}name[\s\S]{0,60}(move|mutat)[\s\S]{0,40}id|two (different )?(location|identit|authorit)|source\.id|wrong location|different location|mismatch.*(id|name)|name and id)/i,
  },
  {
    id: 'DB3-sibling-owner',
    fn: 'bulkUpdateOrders',
    family: 'guard scoped to sibling path',
    difficulty: 'medium',
    desc: 'api.bulkUpdateOrders calls store.applyUpdate directly with no ownership check, while updateOrder guards ownership; a user can patch anyone\'s orders via the bulk path.',
    nameRe: /bulkUpdateOrders/i,
    symptomRe: /(ownership|owner|userid|authoriz|forbidden|permission|access control|any (user|order)|other users?|without (checking|validating|verifying)|no (ownership|owner|auth|check)|bypass|skips? the (owner|ownership|auth)|does not (check|verify).*(owner|user))/i,
  },
  {
    id: 'DB4-capability-key',
    fn: 'attachReceipt',
    family: 'capability treated as arbitrary key',
    difficulty: 'hard',
    desc: 'api.attachReceipt checks the receipt ref EXISTS (blobExists) but not that req.userId owns it (receiptOwner unused); a user can attach another user\'s receipt.',
    nameRe: /attachReceipt/i,
    symptomRe: /(owner|ownership|receiptowner|belongs to|another user|other user'?s?|user-scoped|not.*(owner|belong)|only checks? (existence|blobexists)|existence but not|cross-user|any (user|receipt)|does not (verify|check).*(owner|user)|authoriz)/i,
  },
  {
    id: 'DB5-stale-cache',
    fn: 'getOrComputeTotal',
    family: 'cache keyed on wrong sentinel',
    difficulty: 'hard',
    desc: 'cache.getOrComputeTotal keys only on order.id and is never invalidated on applyUpdate; after order lines/discount change, a stale total is returned.',
    nameRe: /getOrComputeTotal|\bcache\b|invalidate/i,
    symptomRe: /(stale|invalidat|never (cleared|invalidated|updated)|keyed (only )?(on|by) (the )?id|content|hash|(order )?changed?|mutat[\s\S]{0,60}(cache|stale)|out of date|does not (invalidate|update|refresh)|applyupdate[\s\S]{0,60}(cache|invalidate)|not invalidated|caches? .*id)/i,
  },
  {
    id: 'DB6-validator-not-mirrored',
    fn: 'importOrders',
    family: 'concept/validator not mirrored to sibling surface',
    difficulty: 'medium',
    desc: 'api.importOrders saves orders directly, bypassing validateOrder (which submitOrder runs), so imported orders can skip taxRegion and other required fields.',
    nameRe: /importOrders/i,
    symptomRe: /(validateorder|validation|bypass|skips?|without (validat|checking)|does not validate|no validation|taxregion|unvalidated|directly|skip.*validat|not validated|missing.*validat|submitorder.*validat)/i,
  },
  {
    id: 'DB7-divergent-render',
    fn: 'receiptText',
    family: 'duplicated divergent render paths',
    difficulty: 'medium',
    desc: 'pricing.receiptText omits the discount line that receiptJson includes; the text receipt total does not reconcile with the shown lines.',
    nameRe: /receiptText|receiptJson|receipt/i,
    symptomRe: /(discount[\s\S]{0,80}(text|omit|miss|drop|absent|not (shown|included|displayed|listed))|text[\s\S]{0,60}discount|omits? the discount|discount line|does not (show|include|list).*discount|reconcil|inconsistent (between|with)|diverg|two (paths|formats|render)|json.*text.*(differ|inconsistent))/i,
  },
  {
    id: 'DB8-vacuous-verifier',
    fn: 'checkPricing',
    family: 'vacuous verifier',
    difficulty: 'hard',
    desc: 'verify.checkPricing asserts on the hand-set literal order.total (===20) instead of the computed t.total, so it always passes regardless of whether computeTotal is correct.',
    nameRe: /checkPricing|verify\.js|verify\b/i,
    symptomRe: /(order\.total|hard-?coded|literal|precomputed|pre-?set|asserts?[\s\S]{0,50}(input|itself|order\.total|20)|never (checks|asserts|uses)[\s\S]{0,40}(computetotal|t\.total|computed|result)|does not (assert|check|use)[\s\S]{0,40}(computetotal|t\.total|result|computed)|vacuous|always passes|tautolog|20 ?===? ?20|compares.*(to )?itself|ignores.*(computetotal|result|t\.total)|not.*computed value|discards? .*t\b)/i,
  },
];

export function gradeText(resultText) {
  const text = resultText == null ? '' : String(resultText);
  const perBug = BUGS.map((bug) => ({
    id: bug.id,
    found: bug.nameRe.test(text) && bug.symptomRe.test(text),
  }));
  const foundCount = perBug.filter((b) => b.found).length;
  return { perBug, foundCount, total: BUGS.length, recall: foundCount / BUGS.length };
}
