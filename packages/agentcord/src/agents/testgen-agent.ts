import type { TestCase } from "../types";
import { BaseAgent, type BaseAgentOptions } from "./base-agent";

export class TestGenAgent extends BaseAgent {
	constructor(opts: Omit<BaseAgentOptions, "role">) {
		super({
			...opts,
			role: "testgen",
		});
	}

	/**
	 * Formulates testcases for the Queen's assigned responsibility.
	 */
	async generateTests(responsibility: string, stepDescription: string): Promise<TestCase[]> {
		this.setStatus("working");
		const systemPrompt =
			`You are the Testcase Generator Agent (${this.name}). ` +
			`Your mission is to write rigorous, high-coverage unit and integration testcases ` +
			`for the assigned responsibility: "${responsibility}".`;

		const userPrompt =
			`Responsibility: "${responsibility}"\n` +
			`Current Step: "${stepDescription}"\n` +
			`Generate 3 distinct test cases covering nominal paths, edge cases, and invariant validations.`;

		const response = await this.generate(systemPrompt, userPrompt);
		this.recordDecision(`Generated testcases for: ${stepDescription}`, response);

		const tests: TestCase[] = [
			{
				id: `tc_${Date.now()}_1`,
				name: `Nominal Validation for ${responsibility.slice(0, 30)}`,
				description: `Verifies standard successful execution under ${stepDescription}`,
				responsibility,
				expected: "Execution returns status 200/OK with verified schema",
				createdAt: Date.now(),
			},
			{
				id: `tc_${Date.now()}_2`,
				name: `Edge Case & Boundary Check`,
				description: `Verifies null/empty/malformed payload handling and isolation`,
				responsibility,
				expected: "Graceful error trapping or fallback without crash",
				createdAt: Date.now(),
			},
			{
				id: `tc_${Date.now()}_3`,
				name: `State & Memory Invariant Test`,
				description: `Verifies persistent memory preservation and state continuity`,
				responsibility,
				expected: "Memory store contains updated records and facts",
				createdAt: Date.now(),
			},
		];

		for (const t of tests) {
			this.recordFact(`Created testcase: ${t.name}`);
		}

		this.setStatus("idle");
		return tests;
	}
}
