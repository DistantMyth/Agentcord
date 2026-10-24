import { describe, expect, test } from "bun:test";
import { ModelConfigManager } from "../src/models/model-config";

describe("Agentcord Per-User & Per-Agent Model Configuration", () => {
	test("allows different users to configure distinct models for Queen, King, and Helpers", () => {
		const manager = new ModelConfigManager();

		// Alice configuration
		manager.setUserModels("Alice", {
			kingModel: "claude-3-7-sonnet",
			queenModel: "gemini-2.5-pro",
			workerModel: "claude-3-5-haiku",
			testgenModel: "gemini-2.5-flash",
			testerModel: "mock-sim-fast",
		});

		// Bob configuration (completely different models)
		manager.setUserModels("Bob", {
			kingModel: "gpt-4.5-preview",
			queenModel: "gpt-4o",
			workerModel: "deepseek-r1:32b",
			testgenModel: "gemini-2.5-flash",
			testerModel: "mock-sim-pro",
		});

		// Check Alice's agents
		expect(manager.getAgentModel("agent_alice_king", "king", "Alice")).toBe("claude-3-7-sonnet");
		expect(manager.getAgentModel("agent_alice_queen", "queen", "Alice")).toBe("gemini-2.5-pro");
		expect(manager.getAgentModel("agent_alice_worker", "worker", "Alice")).toBe("claude-3-5-haiku");

		// Check Bob's agents
		expect(manager.getAgentModel("agent_bob_queen", "queen", "Bob")).toBe("gpt-4o");
		expect(manager.getAgentModel("agent_bob_worker", "worker", "Bob")).toBe("deepseek-r1:32b");
		expect(manager.getAgentModel("agent_bob_tester", "tester", "Bob")).toBe("mock-sim-pro");
	});

	test("allows specific agent overrides", () => {
		const manager = new ModelConfigManager();
		manager.setUserModels("Charlie", {
			workerModel: "claude-3-5-haiku",
		});

		const defaultWorkerModel = manager.getAgentModel("worker_charlie_1", "worker", "Charlie");
		expect(defaultWorkerModel).toBe("claude-3-5-haiku");

		// Override specific agent
		manager.setAgentModel("worker_charlie_1", "o3-mini");
		const overriddenModel = manager.getAgentModel("worker_charlie_1", "worker", "Charlie");
		expect(overriddenModel).toBe("o3-mini");
	});
});
