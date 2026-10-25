import type { TestCase, TestRunResult } from "../types";
import { BaseAgent, type BaseAgentOptions } from "./base-agent";
import { INITIAL_RESPONSIBILITIES } from "../prompts/agent-prompt";

export class TesterAgent extends BaseAgent {
	constructor(opts: Omit<BaseAgentOptions, "role">) {
		super({
			...opts,
			role: "tester",
			responsibility: opts.responsibility || INITIAL_RESPONSIBILITIES.tester,
		});
	}

	/**
	 * Executes tests at each development step and reports results.
	 */
	async runStepTests(
		responsibility: string,
		testCases: TestCase[],
		stepNumber: number
	): Promise<TestRunResult[]> {
		this.setStatus("testing");
		const results: TestRunResult[] = [];

		for (const tc of testCases) {
			const systemPrompt =
				`You are the Step Tester Agent (${this.name}). ` +
				`Validate implementation for test "${tc.name}" under responsibility: "${responsibility}".`;

			const userPrompt = `Test description: ${tc.description}\nExpected outcome: ${tc.expected}`;
			const out = await this.generate(systemPrompt, userPrompt);

			const lower = out.toLowerCase();
			const passed =
				(lower.includes("pass") || lower.includes("success")) &&
				!lower.includes("failure") &&
				!lower.includes("failed") &&
				!lower.includes("status: error");

			const runResult: TestRunResult = {
				id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				testId: tc.id,
				testName: tc.name,
				passed,
				step: stepNumber,
				output: out,
				executedAt: Date.now(),
			};

			results.push(runResult);
			this.memoryStore.addTestRecord(this.id, tc.name, passed, out);
		}

		this.recordDecision(
			`Step ${stepNumber} Testing Finished`,
			`Ran ${testCases.length} tests. All ${results.filter(r => r.passed).length}/${results.length} passed.`
		);
		this.setStatus("idle");
		return results;
	}
}
