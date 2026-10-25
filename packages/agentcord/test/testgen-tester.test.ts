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

		// 3. Verify Primary Worker agent is automatically present
		expect(queen.primaryWorker).toBeDefined();
		expect(queen.primaryWorker.role).toBe("worker");
		expect(queen.primaryWorker.name).toBe("[Worker: Alice - Worker]");

		// All subagents list contains primaryWorker, TestGen, and Tester
		const subagents = queen.getAllSubagents();
		expect(subagents.length).toBe(3);
		expect(subagents.some((s) => s.name === "[Worker: Alice - Worker]")).toBe(true);
		expect(subagents.some((s) => s.name === "[TestGen: Alice]")).toBe(true);
		expect(subagents.some((s) => s.name === "[Tester: Alice]")).toBe(true);
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

	test("Queen can edit and assign responsibilities to each subagent individually", () => {
		const queen = new QueenAgent({
			owner: "Diana",
			responsibility: "Data Pipeline",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});

		// Queen assigns new responsibility to worker
		const workerAssigned = queen.assignSubagentResponsibility("worker", "Build Kafka producer adapter");
		expect(workerAssigned).toBe(true);
		expect(queen.primaryWorker.responsibility).toBe("Build Kafka producer adapter");

		// Queen assigns new responsibility to testgen
		const testgenAssigned = queen.assignSubagentResponsibility("testgen", "Generate edge case tests for schema mismatch");
		expect(testgenAssigned).toBe(true);
		expect(queen.testgenAgent.responsibility).toBe("Generate edge case tests for schema mismatch");

		// Queen assigns new responsibility to tester
		const testerAssigned = queen.assignSubagentResponsibility("tester", "Execute load testing suite with mock broker");
		expect(testerAssigned).toBe(true);
		expect(queen.testerAgent.responsibility).toBe("Execute load testing suite with mock broker");
	});
});
