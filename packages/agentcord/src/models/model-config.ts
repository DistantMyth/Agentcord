import type { AgentRole } from "../types";

export interface UserRoleModels {
	kingModel: string;
	queenModel: string;
	workerModel: string;
	testgenModel: string;
	testerModel: string;
}

export interface ModelDescriptor {
	id: string;
	name: string;
	provider: "anthropic" | "openai" | "google" | "ollama" | "simulation";
	description: string;
}

export const CATALOG_MODELS: ModelDescriptor[] = [
	{
		id: "claude-3-7-sonnet",
		name: "Claude 3.7 Sonnet (Hybrid Reasoning)",
		provider: "anthropic",
		description: "Top-tier architectural reasoning and code generation",
	},
	{
		id: "claude-3-5-haiku",
		name: "Claude 3.5 Haiku",
		provider: "anthropic",
		description: "Ultra-fast execution and lightweight agent tasks",
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		provider: "google",
		description: "Massive context window with deep multi-agent planning",
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		provider: "google",
		description: "Sub-second responsiveness for worker tasks and step testing",
	},
	{
		id: "gpt-4.5-preview",
		name: "GPT-4.5 Preview",
		provider: "openai",
		description: "OpenAI premier reasoning agent model",
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		provider: "openai",
		description: "Versatile multimodal coding model",
	},
	{
		id: "deepseek-r1:32b",
		name: "DeepSeek R1 (Ollama Local)",
		provider: "ollama",
		description: "Open weights reasoning model running on local machine",
	},
	{
		id: "mock-sim-pro",
		name: "Agentcord Pro Simulator (Offline Mode)",
		provider: "simulation",
		description: "Deterministic intelligent simulator for offline development & tests",
	},
	{
		id: "mock-sim-fast",
		name: "Agentcord Fast Simulator (Offline Mode)",
		provider: "simulation",
		description: "Lightning-fast mocked completions for tests and demos",
	},
];

export const DEFAULT_MODELS: UserRoleModels = {
	kingModel: "claude-3-7-sonnet",
	queenModel: "gemini-2.5-pro",
	workerModel: "claude-3-5-haiku",
	testgenModel: "gemini-2.5-flash",
	testerModel: "mock-sim-fast",
};

export class ModelConfigManager {
	private readonly userDefaults = new Map<string, UserRoleModels>();
	private readonly agentSpecific = new Map<string, string>();

	setUserModels(user: string, models: Partial<UserRoleModels>): void {
		const existing = this.getUserModels(user);
		this.userDefaults.set(user, { ...existing, ...models });
	}

	getUserModels(user: string): UserRoleModels {
		const existing = this.userDefaults.get(user);
		if (existing) return existing;
		const defaults: UserRoleModels = { ...DEFAULT_MODELS };
		this.userDefaults.set(user, defaults);
		return defaults;
	}

	setAgentModel(agentId: string, model: string): void {
		this.agentSpecific.set(agentId, model);
	}

	getModelForRole(role: AgentRole, user: string): string {
		const userModels = this.getUserModels(user);
		switch (role) {
			case "king":
				return userModels.kingModel;
			case "queen":
				return userModels.queenModel;
			case "worker":
				return userModels.workerModel;
			case "testgen":
				return userModels.testgenModel;
			case "tester":
				return userModels.testerModel;
			default:
				return userModels.workerModel;
		}
	}

	getAgentModel(agentId: string, role: AgentRole, user: string): string {
		const specific = this.agentSpecific.get(agentId);
		if (specific) return specific;

		const userModels = this.getUserModels(user);
		switch (role) {
			case "king":
				return userModels.kingModel;
			case "queen":
				return userModels.queenModel;
			case "worker":
				return userModels.workerModel;
			case "testgen":
				return userModels.testgenModel;
			case "tester":
				return userModels.testerModel;
			default:
				return userModels.workerModel;
		}
	}

	getAvailableModels(): ModelDescriptor[] {
		return [...CATALOG_MODELS];
	}
}
