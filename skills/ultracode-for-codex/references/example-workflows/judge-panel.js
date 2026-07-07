export const meta = {
  name: "judge-panel",
  description: "Generate competing approaches, score each with an independent judge panel, synthesize the winner",
  phases: [
    { title: "Generate", detail: "One author per approach angle" },
    { title: "Judge", detail: "Independent judges score every approach across lenses" },
    { title: "Decide", detail: "Synthesize the winner, grafting the best of the rest" }
  ]
};
// Example workflow: generate competing approaches, score each with an
// independent multi-lens judge panel, then synthesize the winner. The
// verify/judge shape is general — the built-in code-review is one instance of
// it (findings verified by adversarial judges), not a special runtime feature.
// Here the same shape decides an open design question.

const input = args && typeof args === "object" ? args : {};
const problem = typeof input.problem === "string" && input.problem.trim()
  ? input.problem
  : "Choose an approach for the requested design problem.";
const angles = Array.isArray(input.angles) && input.angles.length
  ? input.angles.map((a) => "" + a)
  : ["simplest thing that works", "most robust for the long term", "fastest to ship"];
const lenses = ["correctness", "maintainability", "risk"];

phase("Generate");
const approaches = await parallel(angles.map((angle, index) => () => agent([
  "Propose one concrete approach to the problem, optimizing for: " + angle,
  "Be specific about the design and its main tradeoff.",
  "",
  "Problem:",
  problem
].join("\n"), { label: "author-" + (index + 1), phase: "Generate", key: "judge/author/" + index })));

phase("Judge");
const scoreSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "reason"],
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    reason: { type: "string", minLength: 1 }
  }
};
// Every surviving approach is judged by every lens, all concurrently.
const scored = await parallel(approaches.filter(Boolean).map((approach, index) => () =>
  parallel(lenses.map((lens) => () => agent([
    "Score this approach from 1 (poor) to 5 (excellent) through the " + lens + " lens, with a one-line reason.",
    "",
    "Problem:",
    problem,
    "",
    "Approach:",
    String(approach)
  ].join("\n"), { label: "judge-" + index + "-" + lens, phase: "Judge", schema: scoreSchema })))
    .then((scores) => ({ index: index, approach: approach, scores: scores.filter(Boolean) }))
));

phase("Decide");
const decision = await agent([
  "Pick the winning approach and synthesize it, grafting the strongest ideas from the runners-up.",
  "State why it wins over the others by their scores.",
  "",
  "Problem:",
  problem,
  "",
  "Scored approaches:",
  JSON.stringify(scored.filter(Boolean), null, 2)
].join("\n"), { label: "judge-decide", phase: "Decide", key: "judge/decide" });

return { problem, approaches: approaches.filter(Boolean), scored: scored.filter(Boolean), decision };
