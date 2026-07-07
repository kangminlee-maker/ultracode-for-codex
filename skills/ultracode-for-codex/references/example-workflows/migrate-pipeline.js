export const meta = {
  name: "migrate-pipeline",
  description: "Plan a migration from the pending change evidence, transform each site, then verify",
  phases: [
    { title: "Discover", detail: "Read change evidence and list analogous sites" },
    { title: "Transform", detail: "One edit proposal per site, in parallel" },
    { title: "Verify", detail: "Check each proposal preserves behavior" }
  ]
};
// Example workflow: a migration pipeline that reasons over the pending change.
// It is a NON-review consumer of workspaceContext({ includeDiff: true }): the
// "change evidence" block (git status change refs + staged/unstaged/committed
// diff refs, with source-snapshot provenance) is general — code review is only
// one of its consumers. Here a migration uses it to propagate a pending change.
// discover -> transform -> verify, each site flowing independently (pipeline).

const input = args && typeof args === "object" ? args : {};
const goal = typeof input.goal === "string" && input.goal.trim()
  ? input.goal
  : "Propagate the pending change to all analogous call sites.";

// includeDiff: true populates the general "change evidence" section.
const context = await workspaceContext({ query: goal, includeDiff: true, diffBaseRef: input.diffBaseRef });

phase("Discover");
const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sites"],
  properties: {
    sites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "reason"],
        properties: {
          file: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 }
        }
      }
    }
  }
};
const plan = await agent([
  "From the change evidence below, list the files that need the same migration to meet the goal.",
  "Use only files present in the evidence. If none, return an empty list.",
  "",
  "Goal:",
  goal,
  "",
  context
].join("\n"), { label: "migrate-discover", phase: "Discover", key: "migrate/discover", schema: planSchema });

const sites = Array.isArray(plan.sites) ? plan.sites : [];
if (sites.length === 0) return { goal, sites: [], transforms: [] };

announcePhasePlan({
  title: "Transform",
  agents: sites.map((site, index) => ({ title: "Site " + (index + 1), label: "migrate-transform-" + (index + 1), focus: site.file }))
});
// pipeline: a site can be verified while another is still being transformed.
const transforms = await pipeline(
  sites,
  (site, _original, index) => agent([
    "Propose the concrete edit for this migration site as a unified-diff-style snippet.",
    "",
    "Goal:",
    goal,
    "",
    "Site:",
    JSON.stringify(site)
  ].join("\n"), { label: "migrate-transform-" + (index + 1), phase: "Transform", key: "migrate/transform/" + index }),
  (proposal, site, index) => agent([
    "Verify the proposed edit preserves behavior and meets the goal. State PASS or the concrete risk.",
    "",
    "Site:",
    JSON.stringify(site),
    "",
    "Proposal:",
    String(proposal)
  ].join("\n"), { label: "migrate-verify-" + (index + 1), phase: "Verify", key: "migrate/verify/" + index })
    .then((verdict) => ({ site, proposal, verdict }))
);

return { goal, sites, transforms: transforms.filter(Boolean) };
