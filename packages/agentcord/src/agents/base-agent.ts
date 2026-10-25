import type { AgentMemoryStore } from "../memory";
import type { AgentProviderClient } from "../models";
import { formatAgentName } from "../naming";
import { buildAgentcordSystemPrompt } from "../prompts/agent-prompt";
import type { AgentInfo, AgentRole, AgentStatus } from "../types";

export interface BaseAgentOptions {
	id?: string;
	role: AgentRole;
	owner: string;
	rawName?: string;
	responsibility: string;
	model: string;
	parentId?: string;
	memoryStore: AgentMemoryStore;
	providerClient: AgentProviderClient;
}

export abstract class BaseAgent {
	readonly id: string;
	readonly role: AgentRole;
	readonly owner: string;
	readonly rawName: string;
	readonly name: string;
	responsibility: string;
	status: AgentStatus = "idle";
	model: string;
	parentId?: string;
	createdAt: number;
	lastActiveAt: number;

	protected readonly memoryStore: AgentMemoryStore;
	protected readonly providerClient: AgentProviderClient;

	constructor(opts: BaseAgentOptions) {
		this.id = opts.id || `${opts.role}_${opts.owner}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		this.role = opts.role;
		this.owner = opts.owner;
		this.rawName = opts.rawName || (opts.role === "worker" ? "Worker" : opts.owner);
		this.name = formatAgentName(this.role, this.owner, this.rawName);
		this.responsibility = opts.responsibility;
		this.model = opts.model;
		this.parentId = opts.parentId;
		this.createdAt = Date.now();
		this.lastActiveAt = Date.now();
		this.memoryStore = opts.memoryStore;
		this.providerClient = opts.providerClient;

		// Initialize persistent memory
		this.memoryStore.loadMemory(this.id, {
			agentName: this.name,
			owner: this.owner,
			role: this.role,
			responsibility: this.responsibility,
		});
	}

	setResponsibility(resp: string): void {
		this.responsibility = resp;
		this.lastActiveAt = Date.now();
		this.memoryStore.updateResponsibility(this.id, resp);
	}

	setStatus(status: AgentStatus): void {
		this.status = status;
		this.lastActiveAt = Date.now();
	}

	setModel(model: string): void {
		this.model = model;
		this.lastActiveAt = Date.now();
	}

	recordFact(fact: string): void {
		this.memoryStore.addFact(this.id, fact);
	}

	recordDecision(decision: string, rationale: string): void {
		this.memoryStore.addDecision(this.id, decision, rationale);
	}

	recordQA(question: string, answer: string, peer: string): void {
		this.memoryStore.addQA(this.id, question, answer, peer);
	}

	getSnapshot(): AgentInfo {
		const memSummary = this.memoryStore.getMemorySummary(this.id);
		return {
			id: this.id,
			name: this.name,
			rawName: this.rawName,
			owner: this.owner,
			role: this.role,
			responsibility: this.responsibility,
			status: this.status,
			model: this.model,
			parentId: this.parentId,
			createdAt: this.createdAt,
			lastActiveAt: this.lastActiveAt,
			memoryCount: memSummary.totalItems,
		};
	}

	getSystemPrompt(extraInstructions?: string): string {
		const base = buildAgentcordSystemPrompt({
			role: this.role,
			name: this.name,
			owner: this.owner,
			responsibility: this.responsibility,
			parentId: this.parentId,
		});
		return extraInstructions ? `${base}\n\n# CURRENT TASK INSTRUCTIONS\n${extraInstructions}` : base;
	}

	protected async generate(systemPrompt: string, userPrompt: string): Promise<string> {
		this.lastActiveAt = Date.now();
		const memoryContext = this.memoryStore.formatPromptMemory(this.id);
		const fullSystemPrompt = `${this.getSystemPrompt(systemPrompt)}\n\n${memoryContext}`;
		return await this.providerClient.generate(
			this.model,
			fullSystemPrompt,
			userPrompt,
			{
				role: this.role,
				agentName: this.name,
				responsibility: this.responsibility,
				memoryContext,
			}
		);
	}
}
