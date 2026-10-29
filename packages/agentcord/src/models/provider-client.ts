import type { AgentRole } from "../types";

export interface GenerateOptions {
	role: AgentRole;
	agentName: string;
	responsibility: string;
	memoryContext?: string;
	temperature?: number;
}

export type LLMCompletionHandler = (
	model: string,
	systemPrompt: string,
	userMessage: string
) => Promise<string | null | undefined>;

export class AgentProviderClient {
	#customHandler?: LLMCompletionHandler;

	constructor(customHandler?: LLMCompletionHandler) {
		this.#customHandler = customHandler;
	}

	setCompletionHandler(handler: LLMCompletionHandler): void {
		this.#customHandler = handler;
	}

	/**
	 * Dispatches prompt to the active omp LLM provider or intelligent simulator.
	 */
	async generate(
		model: string,
		systemPrompt: string,
		userMessage: string,
		options: GenerateOptions
	): Promise<string> {
		if (model === "mock-sim-pro" || model === "mock-sim-fast") {
			return this.generateSimulatedResponse(model, systemPrompt, userMessage, options);
		}
		if (!this.#customHandler) throw new Error("No provider is connected. Use the Agentcord OMP runner for real execution.");
		const response = await this.#customHandler(model, systemPrompt, userMessage);
		if (!response) throw new Error(`Provider ${model} returned no completion; no simulated result was substituted`);
		return response;
	}

	/**
	 * Intelligent role-specific response generator for offline, test, and demo modes.
	 */
	private generateSimulatedResponse(
		model: string,
		_systemPrompt: string,
		userMessage: string,
		options: GenerateOptions
	): string {
		const { role, agentName, responsibility } = options;
		const cleanQuery = userMessage.trim();

		switch (role) {
			case "king":
				return `[King's Ruling from ${agentName} (Model: ${model})]\n` +
					`Regarding: "${cleanQuery}"\n` +
					`Global Directive: Maintain architecture coherence across all Queen agents. ` +
					`Approved approach: Proceed with the requested design while ensuring integration tests pass and preserving state in .agentcord/memory. ` +
					`Action item for Queen: Delegate test generation to your [TestGen] helper and verify execution with [Tester].`;

			case "queen":
				return `[Queen's Guidance from ${agentName} (Model: ${model})]\n` +
					`Under user responsibility: "${responsibility}"\n` +
					`Analysis: Received query "${cleanQuery}". ` +
					`Guidance: The plan is aligned with our assigned domain. Worker should execute the step and notify [Tester] for validation. ` +
					`If cross-domain coordination is needed, I will escalate to [King].`;

			case "worker":
				return `[Worker Output from ${agentName} (Model: ${model})]\n` +
					`Task: "${responsibility}"\n` +
					`Executed step for: "${cleanQuery}". ` +
					`Status: Implementation complete. Handing over artifacts for verification.`;

			case "testgen":
				return `[TestGen Suite from ${agentName} (Model: ${model})]\n` +
					`Generated comprehensive test suite for: "${responsibility} / ${cleanQuery}":\n` +
					`1. Assert input validation and boundary constraints\n` +
					`2. Verify persistent memory schema consistency\n` +
					`3. Confirm non-blocking Q&A escalation to Queen/King`;

			case "tester":
				return `[Tester Verification from ${agentName} (Model: ${model})]\n` +
					`Ran step verification for "${responsibility}":\n` +
					`Result: PASSED (All 6 step verification checks passed successfully in 14ms). Diagnostics: Zero errors encountered.`;

			default:
				return `[${agentName}] Response to "${cleanQuery}" generated using ${model}.`;
		}
	}
}
