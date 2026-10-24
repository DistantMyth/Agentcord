import { describe, expect, test } from "bun:test";
import { AgentRegistry, KingAgent, QueenAgent } from "../src/agents";
import { AgentMemoryStore } from "../src/memory";
import { AgentProviderClient } from "../src/models";

describe("Agentcord Hierarchy & Q&A Protocol", () => {
	const memoryStore = new AgentMemoryStore();
	const providerClient = new AgentProviderClient();
	const registry = new AgentRegistry();

	test("King agent assigns responsibilities and answers Queen questions", async () => {
		const king = new KingAgent({
			owner: "Alice",
			responsibility: "Master Architectural Oversight",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});
		registry.registerAgent(king);

		expect(king.role).toBe("king");
		expect(king.name).toBe("[King: Alice]");

		// Decompose goal
		const assignments = await king.decomposeGoal("Build Distributed Chat with End-to-End Encryption", [
			"[Queen: Alice]",
			"[Queen: Bob]",
		]);
		expect(assignments["[Queen: Alice]"]).toBeDefined();
		expect(assignments["[Queen: Bob]"]).toBeDefined();

		// Queen asks King
		const answer = await king.answerQueenQuestion(
			"[Queen: Bob]",
			"Should we use AES-GCM or ChaCha20-Poly1305 for the socket payload?"
		);
		expect(answer).toContain("[King's Ruling from [King: Alice]");
		expect(answer).toContain("Approved approach");

		// King's memory has recorded the decision
		const mem = memoryStore.get(king.id);
		expect(mem?.qaHistory.length).toBeGreaterThan(0);
	});

	test("Queen agent commands workers and answers Worker questions", async () => {
		const queenAlice = new QueenAgent({
			owner: "Alice",
			responsibility: "Frontend GUI and WebSocket Client",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});
		registry.registerAgent(queenAlice);

		const queenBob = new QueenAgent({
			owner: "Bob",
			responsibility: "Backend Relay Server and Database",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});
		registry.registerAgent(queenBob);

		// Queen Bob spawns a worker
		const dbWorker = queenBob.spawnWorker("DatabaseWorker", "Design PostgreSQL schemas and indices");
		registry.registerAgent(dbWorker);

		expect(dbWorker.name).toBe("[Worker: Bob - DatabaseWorker]");
		expect(dbWorker.parentId).toBe(queenBob.id);

		// Worker asks Queen Bob (its own Queen)
		const answerBob = await dbWorker.askQueen(queenBob, "What indexing strategy should we use for messages?");
		expect(answerBob).toContain("[Queen's Guidance from [Queen: Bob]");

		// Worker asks Queen Alice (DIFFERENT Queen over the network!)
		// "Each Worker Agent should be able to ask questions to any of the Queen agents"
		const answerAlice = await dbWorker.askQueen(
			queenAlice,
			"What fields does the frontend UI expect in the message payload?"
		);
		expect(answerAlice).toContain("[Queen's Guidance from [Queen: Alice]");
		expect(answerAlice).toContain("Frontend GUI and WebSocket Client");

		// Both worker and queen record Q&A in memory
		const workerMem = memoryStore.get(dbWorker.id);
		expect(workerMem?.qaHistory.length).toBe(2);
	});
});
