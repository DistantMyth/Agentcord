import { BaseAgent, type BaseAgentOptions } from "./base-agent";
import type { QueenAgent } from "./queen-agent";

export class WorkerAgent extends BaseAgent {
	constructor(opts: Omit<BaseAgentOptions, "role">) {
		super({
			...opts,
			role: "worker",
		});
	}

	/**
	 * Worker Agent can ask questions to ANY Queen agent across the network.
	 */
	async askQueen(queen: QueenAgent, question: string): Promise<string> {
		this.setStatus("questioning");
		const answer = await queen.answerWorkerQuestion(this.name, question);
		this.recordQA(question, answer, queen.name);
		this.setStatus("working");
		return answer;
	}

	/**
	 * Executes a designated work task.
	 */
	async executeTask(taskPrompt: string): Promise<string> {
		this.setStatus("working");
		const systemPrompt =
			`You are Worker Agent (${this.name}), dedicated to: "${this.responsibility}". ` +
			`Complete the requested sub-task with high precision, maintaining clean code and strict compliance.`;

		const output = await this.generate(systemPrompt, taskPrompt);
		this.recordDecision(`Executed task: ${taskPrompt}`, output);
		this.setStatus("idle");
		return output;
	}
}
