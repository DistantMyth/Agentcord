import { BaseAgent, type BaseAgentOptions } from "./base-agent";
import type { KingAgent } from "./king-agent";
import { TestGenAgent } from "./testgen-agent";
import { TesterAgent } from "./tester-agent";
import { WorkerAgent } from "./worker-agent";
import { INITIAL_RESPONSIBILITIES } from "../prompts/agent-prompt";

export interface QueenAgentOptions extends Omit<BaseAgentOptions, "role"> {
	testgenModel?: string;
	testerModel?: string;
	workerModel?: string;
	workerResponsibility?: string;
}

export class QueenAgent extends BaseAgent {
	testgenAgent: TestGenAgent;
	testerAgent: TesterAgent;
	primaryWorker: WorkerAgent;
	readonly workers = new Map<string, WorkerAgent>();

	private readonly testgenModel: string;
	private readonly testerModel: string;
	private readonly workerModel: string;

	constructor(opts: QueenAgentOptions) {
		super({
			...opts,
			role: "queen",
			responsibility: opts.responsibility || INITIAL_RESPONSIBILITIES.queen,
		});

		this.testgenModel = opts.testgenModel || opts.model;
		this.testerModel = opts.testerModel || opts.model;
		this.workerModel = opts.workerModel || opts.model;

		// Automatically spin up the required subagents under this Queen:
		// 1. Testcase Generator Agent
		this.testgenAgent = new TestGenAgent({
			owner: this.owner,
			responsibility: INITIAL_RESPONSIBILITIES.testgen,
			model: this.testgenModel,
			parentId: this.id,
			memoryStore: this.memoryStore,
			providerClient: this.providerClient,
		});

		// 2. Step Tester Agent
		this.testerAgent = new TesterAgent({
			owner: this.owner,
			responsibility: INITIAL_RESPONSIBILITIES.tester,
			model: this.testerModel,
			parentId: this.id,
			memoryStore: this.memoryStore,
			providerClient: this.providerClient,
		});

		// 3. Primary Worker Agent (ensures Worker is present at start)
		this.primaryWorker = new WorkerAgent({
			owner: this.owner,
			rawName: "Worker",
			responsibility: opts.workerResponsibility || INITIAL_RESPONSIBILITIES.worker,
			model: this.workerModel,
			parentId: this.id,
			memoryStore: this.memoryStore,
			providerClient: this.providerClient,
		});
		this.primaryWorker.setStatus("active");
		this.workers.set(this.primaryWorker.id, this.primaryWorker);

		this.recordDecision(
			`Spun up initial helper subagents under Queen`,
			`Initialized ${this.primaryWorker.name} (worker), ${this.testgenAgent.name} (testgen), and ${this.testerAgent.name} (tester)`
		);
	}

	override setResponsibility(resp: string): void {
		super.setResponsibility(resp);
		this.testgenAgent.setResponsibility(`Generate testcases for: ${resp}`);
		this.testerAgent.setResponsibility(`Execute step verification tests for: ${resp}`);
	}

	/**
	 * Spawns a new delegated worker helper agent under this Queen.
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
		worker.setStatus("active");

		this.workers.set(worker.id, worker);
		this.recordDecision(
			`Spun up worker ${worker.name}`,
			`Assigned task: ${taskResponsibility} (Model: ${worker.model})`
		);
		return worker;
	}

	/**
	 * Assign or edit responsibility of any subagent under this Queen (Worker, TestGen, or Tester).
	 */
	assignSubagentResponsibility(subagentIdOrName: string, newResponsibility: string): boolean {
		const target = subagentIdOrName.trim().toLowerCase();

		// Check TestGen
		if (
			this.testgenAgent.id.toLowerCase() === target ||
			this.testgenAgent.name.toLowerCase() === target ||
			target.includes("testgen")
		) {
			this.testgenAgent.setResponsibility(newResponsibility);
			this.recordDecision(
				`Reassigned TestGen responsibility`,
				`New responsibility: "${newResponsibility}"`
			);
			return true;
		}

		// Check Tester
		if (
			this.testerAgent.id.toLowerCase() === target ||
			this.testerAgent.name.toLowerCase() === target ||
			target.includes("tester")
		) {
			this.testerAgent.setResponsibility(newResponsibility);
			this.recordDecision(
				`Reassigned Tester responsibility`,
				`New responsibility: "${newResponsibility}"`
			);
			return true;
		}

		// Check specific Workers
		for (const worker of this.workers.values()) {
			if (
				worker.id.toLowerCase() === target ||
				worker.name.toLowerCase() === target ||
				worker.rawName.toLowerCase() === target
			) {
				worker.setResponsibility(newResponsibility);
				this.recordDecision(
					`Reassigned Worker ${worker.name} responsibility`,
					`New responsibility: "${newResponsibility}"`
				);
				return true;
			}
		}

		// If target is generic "worker" or "primary", update primary worker
		if ((target === "worker" || target === "primary") && this.primaryWorker) {
			this.primaryWorker.setResponsibility(newResponsibility);
			this.recordDecision(
				`Reassigned Primary Worker ${this.primaryWorker.name} responsibility`,
				`New responsibility: "${newResponsibility}"`
			);
			return true;
		}

		return false;
	}

	assignWorkerResponsibility(workerIdOrName: string, newResponsibility: string): boolean {
		return this.assignSubagentResponsibility(workerIdOrName, newResponsibility);
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
		const result: BaseAgent[] = [this.primaryWorker, this.testgenAgent, this.testerAgent];
		for (const worker of this.workers.values()) {
			if (worker.id !== this.primaryWorker.id) {
				result.push(worker);
			}
		}
		return result;
	}
}
