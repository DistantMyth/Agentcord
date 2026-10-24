import { BaseAgent, type BaseAgentOptions } from "./base-agent";

export class KingAgent extends BaseAgent {
	constructor(opts: Omit<BaseAgentOptions, "role">) {
		super({
			...opts,
			role: "king",
		});
	}

	/**
	 * Decomposes a master project goal into distinct responsibilities for Queen agents.
	 */
	async decomposeGoal(masterGoal: string, connectedQueens: string[]): Promise<Record<string, string>> {
		this.setStatus("planning");
		const systemPrompt =
			`You are the King Agent (${this.name}), the master orchestrator of the collaborative network. ` +
			`Your role is to decompose the overall project goal into distinct, high-impact responsibilities ` +
			`for each user's Queen agent. Ensure clear boundaries and no overlaps.`;

		const userPrompt =
			`Master Goal: "${masterGoal}"\n` +
			`Connected Queens: ${connectedQueens.join(", ")}\n` +
			`Assign a primary responsibility to each Queen.`;

		const response = await this.generate(systemPrompt, userPrompt);
		this.recordDecision(`Decomposed master goal: "${masterGoal}"`, response);
		this.setStatus("working");

		// Provide structured fallback assignments if LLM is concise
		const assignments: Record<string, string> = {};
		for (let i = 0; i < connectedQueens.length; i++) {
			const q = connectedQueens[i]!;
			assignments[q] = `Module ${i + 1} for: ${masterGoal}`;
		}
		return assignments;
	}

	/**
	 * Answers an architectural or project question escalated by a Queen agent.
	 */
	async answerQueenQuestion(fromQueen: string, question: string): Promise<string> {
		this.setStatus("questioning");
		const systemPrompt =
			`You are the King Agent (${this.name}), the supreme architectural authority. ` +
			`A Queen agent (${fromQueen}) has escalated an important question. ` +
			`Consult your preserved memory and global objective to give a decisive, clear directive.`;

		const userPrompt = `Question from ${fromQueen}: "${question}"`;
		const answer = await this.generate(systemPrompt, userPrompt);

		this.recordQA(question, answer, fromQueen);
		this.recordDecision(`Ruling for ${fromQueen}: ${question}`, answer);
		this.setStatus("working");
		return answer;
	}
}
