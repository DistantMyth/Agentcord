import { BaseAgent, type BaseAgentOptions } from "./base-agent";
import type { KingAgent } from "./king-agent";
import { TestGenAgent } from "./testgen-agent";
import { TesterAgent } from "./tester-agent";
import { WorkerAgent } from "./worker-agent";

export interface QueenAgentOptions extends Omit<BaseAgentOptions, "role"> {
	testgenModel?: string;
	testerModel?: string;
	workerModel?: string;
}

export class QueenAgent extends BaseAgent {
	testgenAgent: TestGenAgent;
	testerAgent: TesterAgent;
	readonly workers = new Map<string, WorkerAgent>();

	private readonly testgenModel: string;
	private readonly testerModel: string;
	private readonly workerModel: string;

	constructor(opts: QueenAgentOptions) {
		super({
			...opts,
			role: "queen",
		});

		this.testgenModel = opts.testgenModel || opts.model;
		this.testerModel = opts.testerModel || opts.model;
		this.workerModel = opts.workerModel || opts.model;

		// Automatically spin up the two required helper agents:
		// 1. Testcase Generator Agent
		this.testgenAgent = new TestGenAgent({
			owner: this.owner,
			responsibility: `Generate testcases for: ${this.responsibility}`,
			model: this.testgenModel,
			parentId: this.id,
			memoryStore: this.memoryStore,
			providerClient: this.providerClient,
		});

		// 2. Step Tester Agent
		this.testerAgent = new TesterAgent({
			owner: this.owner,
			responsibility: `Execute step verification tests for: ${this.responsibility}`,
			model: this.testerModel,
			parentId: this.id,
			memoryStore: this.memoryStore,
			providerClient: this.providerClient,
		});

		this.recordDecision(
			`Spun up specialized helper subagents`,
			`Initialized ${this.testgenAgent.name} (model: ${this.testgenModel}) and ${this.testerAgent.name} (model: ${this.testerModel})`
		);
	}

	override setResponsibility(resp: string): void {
		super.setResponsibility(resp);
		this.testgenAgent.setResponsibility(`Generate testcases for: ${resp}`);
		this.testerAgent.setResponsibility(`Execute step verification tests for: ${resp}`);
	}

	/**
	 * Spawns a new delegated worker/helper agent under this Queen.
	 */
	spawnWorker(workerName: string, taskResponsibility: string, model?: string): WorkerAgent {
		const worker = new WorkerAgent({
			owner: this.owner,
			rawName: workerName,
			responsibility: taskResponsibility,
			model: model || this.workerModel,
			parentId: this.id,
			memoryStore: this.memoryStore,
			providerClient: this.providerClient,
		});

		this.workers.set(worker.id, worker);
		this.recordDecision(
			`Spun up worker ${worker.name}`,
			`Assigned task: ${taskResponsibility} (Model: ${worker.model})`
		);
		return worker;
	}

	/**
	 * Worker agents from ANY Queen can ask questions to this Queen.
	 */
	async answerWorkerQuestion(fromWorker: string, question: string): Promise<string> {
		this.setStatus("questioning");
		const systemPrompt =
			`You are Queen Agent (${this.name}), in charge of: "${this.responsibility}". ` +
			`A worker agent (${fromWorker}) has asked you a domain question. ` +
			`Answer accurately based on your preserved memory and responsibility boundaries.`;

		const userPrompt = `Worker Question from ${fromWorker}: "${question}"`;
		const answer = await this.generate(systemPrompt, userPrompt);

		this.recordQA(question, answer, fromWorker);
		this.setStatus("working");
		return answer;
	}

	/**
	 * Asks a question to the master King Agent.
	 */
	async askKing(king: KingAgent, question: string): Promise<string> {
		this.setStatus("questioning");
		const answer = await king.answerQueenQuestion(this.name, question);
		this.recordQA(question, answer, king.name);
		this.setStatus("working");
		return answer;
	}

	/**
	 * Runs the test generation and step testing cycle.
	 */
	async runTestCycle(stepDescription: string) {
		const testcases = await this.testgenAgent.generateTests(this.responsibility, stepDescription);
		const testResults = await this.testerAgent.runStepTests(this.responsibility, testcases, 1);
		return {
			testcases,
			testResults,
		};
	}

	getAllSubagents(): BaseAgent[] {
		return [this.testgenAgent, this.testerAgent, ...this.workers.values()];
	}
}
