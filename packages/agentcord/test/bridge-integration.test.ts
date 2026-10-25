import { describe, expect, test, afterAll } from "bun:test";
import { AgentcordBridge } from "../../coding-agent/src/agentcord/bridge";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../../coding-agent/src/slash-commands/builtin-registry";
import { INITIAL_RESPONSIBILITIES, buildAgentcordSystemPrompt } from "../src/prompts";

describe("Agentcord Bridge & Native Omp Integration", () => {
	const bridge = new AgentcordBridge({
		userName: "Alice",
		isKing: true,
		port: 8499,
	});

	afterAll(async () => {
		await bridge.stop();
	});

	test("AgentcordBridge initializes with correct naming format and Queen/King/Worker agents", () => {
		expect(bridge.userName).toBe("Alice");
		expect(bridge.isKing).toBe(true);

		// King agent
		expect(bridge.kingAgent).toBeDefined();
		expect(bridge.kingAgent?.name).toBe("[King: Alice]");
		expect(bridge.kingAgent?.responsibility).toBe(INITIAL_RESPONSIBILITIES.king);

		// Queen agent
		expect(bridge.queenAgent).toBeDefined();
		expect(bridge.queenAgent.name).toBe("[Queen: Alice]");
		expect(bridge.queenAgent.responsibility).toBe(INITIAL_RESPONSIBILITIES.queen);

		// Primary Worker agent (automatically present at startup)
		expect(bridge.workerAgent).toBeDefined();
		expect(bridge.workerAgent.name).toBe("[Worker: Alice - Worker]");
		expect(bridge.workerAgent.responsibility).toBe(INITIAL_RESPONSIBILITIES.worker);

		// Queen helper agents
		expect(bridge.testGenAgent).toBeDefined();
		expect(bridge.testGenAgent.name).toBe("[TestGen: Alice]");
		expect(bridge.testGenAgent.responsibility).toBe(INITIAL_RESPONSIBILITIES.testgen);

		expect(bridge.testerAgent).toBeDefined();
		expect(bridge.testerAgent.name).toBe("[Tester: Alice]");
		expect(bridge.testerAgent.responsibility).toBe(INITIAL_RESPONSIBILITIES.tester);
	});

	test("Initial responsibilities are vague and Queen matches exact requirement", () => {
		expect(INITIAL_RESPONSIBILITIES.queen).toBe(
			"Take the tasks and responsibilities assigned by the King agent, break it into smaller parts, Use helper agents to complete the task, keep making testcases for each of the thing along the way using testgen agent and test things out finally with tester agent at each step, along with the instructions on how to actually use the communication layer we are building"
		);
		expect(INITIAL_RESPONSIBILITIES.king).toContain("Coordinate multi-user project architecture");
		expect(INITIAL_RESPONSIBILITIES.worker).toContain("Execute technical subtasks assigned by the Queen agent");
	});

	test("Hierarchy authority: King assigns Queen, Queen assigns subagents, unauthorized blocked", () => {
		// 1. King assigns Queen responsibility
		const kingAssignsQueen = bridge.assignResponsibility("king", "queen", "Implement User Authentication Module");
		expect(kingAssignsQueen).toBe(true);
		expect(bridge.queenAgent.responsibility).toBe("Implement User Authentication Module");

		// 2. Queen assigns Worker responsibility
		const queenAssignsWorker = bridge.assignResponsibility("queen", "worker", "Implement JWT token signing & bcrypt hashing");
		expect(queenAssignsWorker).toBe(true);
		expect(bridge.workerAgent.responsibility).toBe("Implement JWT token signing & bcrypt hashing");

		// 3. Queen assigns TestGen responsibility
		const queenAssignsTestGen = bridge.assignResponsibility("queen", "testgen", "Generate auth edge-case test suite");
		expect(queenAssignsTestGen).toBe(true);
		expect(bridge.testGenAgent.responsibility).toBe("Generate auth edge-case test suite");

		// 4. Queen assigns Tester responsibility
		const queenAssignsTester = bridge.assignResponsibility("queen", "tester", "Run regression tests on auth endpoints");
		expect(queenAssignsTester).toBe(true);
		expect(bridge.testerAgent.responsibility).toBe("Run regression tests on auth endpoints");

		// 5. Unauthorized: Worker cannot assign King or Queen
		const workerAssignsKing = bridge.assignResponsibility("worker", "king", "Unauthorized override");
		expect(workerAssignsKing).toBe(false);

		const workerAssignsQueen = bridge.assignResponsibility("worker", "queen", "Unauthorized override");
		expect(workerAssignsQueen).toBe(false);
	});

	test("System prompt preserves omp tooling and incorporates communication layer", () => {
		const prompt = buildAgentcordSystemPrompt({
			role: "queen",
			name: "[Queen: Alice]",
			owner: "Alice",
			responsibility: INITIAL_RESPONSIBILITIES.queen,
		});

		// Native omp tooling instructions preserved
		expect(prompt).toContain("OMP CODING ASSISTANT BASE CAPABILITIES");
		expect(prompt).toContain("read: Inspect file contents");
		expect(prompt).toContain("write: Create new files");
		expect(prompt).toContain("edit: Apply exact search-and-replace");
		expect(prompt).toContain("bash: Execute shell commands");
		expect(prompt).toContain("grep & glob");
		expect(prompt).toContain("lsp: Language server intelligence");

		// Agentcord communication layer & hierarchy instructions
		expect(prompt).toContain("AGENTCORD COLLABORATIVE PROTOCOL & IDENTITY");
		expect(prompt).toContain("King Agent [King: <User>]");
		expect(prompt).toContain("Queen Agent [Queen: <User>]");
		expect(prompt).toContain("Worker Agent [Worker: <User> - <Name>]");
		expect(prompt).toContain("TestGen Agent [TestGen: <User>]");
		expect(prompt).toContain("Tester Agent [Tester: <User>]");
		expect(prompt).toContain("Context Shield");
		expect(prompt).toContain("Escalation Protocol");
		expect(prompt).toContain("Step Testing Cycle");
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
