export const meta = {
  name: "research-fan-out",
  description: "Fan out a question across independent angles, then synthesize a single answer",
  phases: [
    { title: "Survey", detail: "One researcher per angle, in parallel" },
    { title: "Synthesize", detail: "Merge the angle findings into one answer" }
  ]
};
// Example workflow: general fan-out-and-synthesize. No code review involved.
// A workflow script must START with `export const meta = {...};` (above), so
// any explanation goes below it. Spawns one researcher per angle in parallel,
// then synthesizes one answer.
// Run: ultracode-for-codex run --accept-llm-guide=v1 --name research-fan-out \
//   --script-file <this file> --args '{"question":"...","angles":["...","..."]}'

const input = args && typeof args === "object" ? args : {};
const question = typeof input.question === "string" && input.question.trim()
  ? input.question
  : "What are the tradeoffs of the current approach?";
const angles = Array.isArray(input.angles) && input.angles.length
  ? input.angles.map((a) => "" + a)
  : ["prior art", "risks and failure modes", "simpler alternatives"];

const context = await workspaceContext({ query: question });

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["angle", "findings"],
  properties: {
    angle: { type: "string", minLength: 1 },
    findings: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
  }
};

announcePhasePlan({
  title: "Survey",
  agents: angles.map((angle, index) => ({ title: "Angle " + (index + 1), label: "research-" + (index + 1), focus: angle }))
});
phase("Survey");
const surveys = await parallel(angles.map((angle, index) => () => agent([
  "Research exactly one angle of the question. Angle: " + angle,
  "Return concrete findings; prefer evidence over generalities.",
  "",
  "Question:",
  question,
  "",
  context
].join("\n"), { label: "research-" + (index + 1), phase: "Survey", key: "research/angle/" + index, schema: findingSchema })));

phase("Synthesize");
const answer = await agent([
  "Synthesize one answer to the question from the angle findings. Note disagreements.",
  "",
  "Question:",
  question,
  "",
  "Angle findings:",
  JSON.stringify(surveys.filter(Boolean), null, 2)
].join("\n"), { label: "research-synthesis", phase: "Synthesize", key: "research/synthesis" });

return { question, angles, surveys: surveys.filter(Boolean), answer };
