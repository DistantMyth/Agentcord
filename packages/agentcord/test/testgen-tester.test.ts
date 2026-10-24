import { describe, expect, test } from "bun:test";
import { QueenAgent } from "../src/agents";
import { AgentMemoryStore } from "../src/memory";
import { AgentProviderClient } from "../src/models";

describe("Queen Helper Agents: Testcase Generator & Step Tester", () => {
	const memoryStore = new AgentMemoryStore();
	const providerClient = new AgentProviderClient();

	test("Queen automatically spins up TestGen and Step Tester helper agents", () => {
		const queen = new QueenAgent({
			owner: "Alice",
			responsibility: "REST API Endpoint Gateway",
			model: "mock-sim-pro",
			testgenModel: "gemini-2.5-flash",
			testerModel: "mock-sim-fast",
			memoryStore,
			providerClient,
		});

		// 1. Verify TestGen agent
		expect(queen.testgenAgent).toBeDefined();
		expect(queen.testgenAgent.role).toBe("testgen");
		expect(queen.testgenAgent.name).toBe("[TestGen: Alice]");
		expect(queen.testgenAgent.model).toBe("gemini-2.5-flash");
		expect(queen.testgenAgent.parentId).toBe(queen.id);

		// 2. Verify Step Tester agent
		expect(queen.testerAgent).toBeDefined();
		expect(queen.testerAgent.role).toBe("tester");
		expect(queen.testerAgent.name).toBe("[Tester: Alice]");
		expect(queen.testerAgent.model).toBe("mock-sim-fast");
		expect(queen.testerAgent.parentId).toBe(queen.id);

		// All subagents list contains both
		const subagents = queen.getAllSubagents();
		expect(subagents.length).toBe(2);
		expect(subagents[0]!.name).toBe("[TestGen: Alice]");
		expect(subagents[1]!.name).toBe("[Tester: Alice]");
	});

	test("Runs full testcase generation and step testing cycle", async () => {
		const queen = new QueenAgent({
			owner: "Bob",
			responsibility: "OAuth2 Provider Integration",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});

		const cycleResult = await queen.runTestCycle("Step 1: Authorization Code Grant Handler");
		expect(cycleResult.testcases.length).toBeGreaterThanOrEqual(3);
		expect(cycleResult.testResults.length).toBe(cycleResult.testcases.length);

		// All step tests pass
		const passedCount = cycleResult.testResults.filter(r => r.passed).length;
		expect(passedCount).toBe(cycleResult.testcases.length);

		// Diagnostics and outputs recorded in memory
		const testerMem = memoryStore.get(queen.testerAgent.id);
		expect(testerMem?.testHistory.length).toBe(cycleResult.testcases.length);
	});

	test("Updating Queen responsibility updates TestGen and Tester responsibilities", () => {
		const queen = new QueenAgent({
			owner: "Charlie",
			responsibility: "Initial Planning",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});

		queen.setResponsibility("Distributed Cache with Raft Consensus");

		expect(queen.responsibility).toBe("Distributed Cache with Raft Consensus");
		expect(queen.testgenAgent.responsibility).toContain("Distributed Cache with Raft Consensus");
		expect(queen.testerAgent.responsibility).toContain("Distributed Cache with Raft Consensus");
	});
});
