/**
 * Runs the scripted conversations in scenarios.ts against the real model.
 *
 *   npm run eval                      all scenarios
 *   npm run eval -- --only late       scenarios whose name or area contains "late"
 *   npm run eval -- --repeat 3        run each scenario three times (models are not deterministic)
 *   npm run eval -- --verbose         print every conversation, not just failures
 *
 * Uses the in-memory calendar and sheet with a fixed clock, so nothing touches Google.
 */
import './env.js';
import { config } from '../src/config.js';
import { GeminiLlm } from '../src/gemini.js';
import { runScenario } from './harness.js';
import { type Outcome, SCENARIOS, type Scenario } from './scenarios.js';

function printConversation(scenario: Scenario, outcome: Outcome) {
  scenario.turns.forEach((turn, i) => {
    console.log(`      caller: ${turn}`);
    for (const t of outcome.tools[i] ?? []) {
      console.log(`        tool: ${t.name}(${JSON.stringify(t.args)}) -> ${JSON.stringify(t.result).slice(0, 300)}`);
    }
    console.log(`       agent: ${outcome.replies[i] ?? '(no reply)'}`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const only = value('--only')?.toLowerCase();
  const repeat = Math.max(1, Number(value('--repeat') ?? 1));
  const verbose = args.includes('--verbose');

  if (!config.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set. Evals run the real model; add the key to .env.');
    process.exit(1);
  }
  const llm = new GeminiLlm();
  const selected = SCENARIOS.filter((s) => !only || s.name.toLowerCase().includes(only) || s.area.toLowerCase().includes(only));
  console.log(`Running ${selected.length} scenario(s) x ${repeat} against ${config.geminiModel}\n`);

  let passed = 0;
  let total = 0;
  for (const scenario of selected) {
    for (let i = 0; i < repeat; i++) {
      total++;
      let result: Awaited<ReturnType<typeof runScenario>>;
      try {
        result = await runScenario(scenario, llm);
      } catch (err) {
        console.log(`ERROR [${scenario.area}] ${scenario.name}\n      ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const ok = result.problems.length === 0;
      if (ok) passed++;
      console.log(`${ok ? 'PASS ' : 'FAIL '} [${scenario.area}] ${scenario.name}`);
      for (const problem of result.problems) console.log(`      - ${problem}`);
      if (!ok || verbose) printConversation(scenario, result.outcome);
    }
  }
  console.log(`\n${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
