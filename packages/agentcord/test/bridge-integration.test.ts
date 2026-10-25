import { describe, expect, test, afterAll } from "bun:test";
import { AgentcordBridge } from "../../coding-agent/src/agentcord/bridge";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../../coding-agent/src/slash-commands/builtin-registry";

describe("Agentcord Bridge & Native Omp Integration", () => {
	const bridge = new AgentcordBridge({
		userName: "Alice",
		isKing: true,
		port: 8499,
	});

	afterAll(async () => {
		await bridge.stop();
	});

	test("AgentcordBridge initializes with correct naming format and Queen/King agents", () => {
		expect(bridge.userName).toBe("Alice");
		expect(bridge.isKing).toBe(true);

		// King agent
		expect(bridge.kingAgent).toBeDefined();
		expect(bridge.kingAgent?.name).toBe("[King: Alice]");

		// Queen agent
		expect(bridge.queenAgent).toBeDefined();
		expect(bridge.queenAgent.name).toBe("[Queen: Alice]");

		// Queen helper agents
		expect(bridge.testGenAgent).toBeDefined();
		expect(bridge.testGenAgent.name).toBe("[TestGen: Alice]");

		expect(bridge.testerAgent).toBeDefined();
		expect(bridge.testerAgent.name).toBe("[Tester: Alice]");
	});

	test("Queen can spawn Worker agents adhering to naming rules", () => {
		const worker = bridge.createWorker("Backend", "Implement database migrations");
		expect(worker.name).toBe("[Worker: Alice - Backend]");
		expect(worker.responsibility).toBe("Implement database migrations");
		expect(worker.status).toBe("active");
	});

	test("Hierarchy escalation: Worker asks Queen, Queen asks King", async () => {
		// Worker asks Queen
		const queenAnswer = await bridge.ask("queen", "Should we index the user email field?");
		expect(queenAnswer).toContain("Queen's Guidance");
		expect(queenAnswer).toContain("Should we index the user email field?");

		// Queen asks King
		const kingAnswer = await bridge.ask("king", "Requesting architecture approval for distributed caching");
		expect(kingAnswer).toContain("King's Ruling");
		expect(kingAnswer).toContain("distributed caching");
	});

	test("Step testing cycle: TestGen creates tests and Tester validates step", async () => {
		const { testcases, result } = await bridge.runStepTest("OAuth login flow implementation");
		expect(testcases.length).toBeGreaterThan(0);
		expect(result.passed).toBe(true);
	});

	test("Context Shield: GC messages are filtered while DMs route strictly", () => {
		// Broadcast GC message without mention
		const gc1 = bridge.sendChat("gc", undefined, "General status update: sprint underway.");
		expect(gc1.type).toBe("gc");

		// Agent context should NOT include irrelevant GC message
		const queenCtx = bridge.chatRoom.getContextForAgent(bridge.queenAgent.name, bridge.queenAgent.role);
		expect(queenCtx).not.toContain("General status update");

		// Broadcast GC message WITH mention
		const gc2 = bridge.sendChat("gc", undefined, "Urgent notice for @Queen please check testing report.");
		const queenCtxAfter = bridge.chatRoom.getContextForAgent(bridge.queenAgent.name, bridge.queenAgent.role);
		expect(queenCtxAfter).toContain("Urgent notice for @Queen");

		// Direct Message (DM)
		const dm = bridge.sendChat("dm", bridge.queenAgent.name, "Private directive from King.");
		expect(dm.type).toBe("dm");
		expect(dm.to).toBe(bridge.queenAgent.name);
		const queenCtxDm = bridge.chatRoom.getContextForAgent(bridge.queenAgent.name, bridge.queenAgent.role);
		expect(queenCtxDm).toContain("Private directive from King.");
	});

	test("Relay and Helper GUI starts cleanly and provides live responsibility matrix", async () => {
		const guiUrl = await bridge.start(8499);
		expect(guiUrl).toBe("http://localhost:8499");

		const matrix = bridge.getResponsibilityMatrix();
		expect(matrix.length).toBeGreaterThanOrEqual(4); // King, Queen, TestGen, Tester

		const queenEntry = matrix.find(e => e.agentName === "[Queen: Alice]");
		expect(queenEntry).toBeDefined();
		expect(["active", "working"]).toContain(queenEntry?.status ?? "");

		const testGenEntry = matrix.find(e => e.agentName === "[TestGen: Alice]");
		expect(testGenEntry).toBeDefined();

		const testerEntry = matrix.find(e => e.agentName === "[Tester: Alice]");
		expect(testerEntry).toBeDefined();
	});

	test("Slash commands: /models and /login exist natively in omp, /agentcord, /ask, /chat are registered", () => {
		// Native omp /model and /models
		const modelCmd = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "model");
		expect(modelCmd).toBeDefined();
		expect(modelCmd?.aliases).toContain("models");

		// Native omp /login
		const loginCmd = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "login");
		expect(loginCmd).toBeDefined();

		// Agentcord commands
		const agentcordCmd = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "agentcord");
		expect(agentcordCmd).toBeDefined();
		expect(agentcordCmd?.aliases).toContain("ac");

		const askCmd = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "ask");
		expect(askCmd).toBeDefined();

		const chatCmd = BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === "chat");
		expect(chatCmd).toBeDefined();
	});
});
