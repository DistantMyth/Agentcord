import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AgentRegistry, KingAgent, QueenAgent } from "../src/agents";
import { ChatRoom } from "../src/chat";
import { AgentMemoryStore } from "../src/memory";
import { AgentProviderClient, ModelConfigManager } from "../src/models";
import { AgentcordPeerClient, AgentcordRelayServer } from "../src/network";

describe("Agentcord Network Relay & Live Responsibility Synchronization", () => {
	let relayServer: AgentcordRelayServer;
	let serverUrl = "";
	const port = 8990;
	const roomId = "test_room_sync";

	const memoryStore = new AgentMemoryStore();
	const modelManager = new ModelConfigManager();
	const registry = new AgentRegistry();
	const chatRoom = new ChatRoom(registry);
	const providerClient = new AgentProviderClient();

	beforeAll(() => {
		// Host Alice setup
		const kingAlice = new KingAgent({
			owner: "Alice",
			responsibility: "Global Architecture and Decision Escalation",
			model: "mock-sim-pro",
			memoryStore,
			providerClient,
		});
		registry.registerAgent(kingAlice);

		const queenAlice = new QueenAgent({
			owner: "Alice",
			responsibility: "Core Gateway Services",
			model: "mock-sim-pro",
			parentId: kingAlice.id,
			memoryStore,
			providerClient,
		});
		registry.registerAgent(queenAlice);

		relayServer = new AgentcordRelayServer({
			port,
			roomId,
			hostUser: "Alice",
			registry,
			chatRoom,
			modelManager,
			memoryStore,
		});

		const res = relayServer.start();
		serverUrl = res.url;
	});

	afterAll(() => {
		relayServer.stop();
	});

	test("Peer connects, syncs room state, and verifies live agent responsibility tracking", async () => {
		let receivedWelcome = false;
		let receivedState: any = null;

		const clientBob = new AgentcordPeerClient({
			relayUrl: serverUrl,
			roomId,
			userName: "Bob",
			queenModel: "gemini-2.5-pro",
			onStateUpdate: state => {
				receivedWelcome = true;
				receivedState = state;
			},
		});

		await clientBob.connect();

		// Wait briefly for handshake
		let retries = 20;
		while (!receivedWelcome && retries-- > 0) {
			await Bun.sleep(25);
		}

		expect(receivedWelcome).toBe(true);
		expect(receivedState.roomId).toBe(roomId);
		expect(receivedState.hostUser).toBe("Alice");

		// Check live agents in room state: should include King Alice and Queen Alice
		const king = receivedState.agents.find((a: any) => a.role === "king");
		expect(king).toBeDefined();
		expect(king.name).toBe("[King: Alice]");
		expect(king.responsibility).toBe("Global Architecture and Decision Escalation");

		const queen = receivedState.agents.find((a: any) => a.role === "queen" && a.owner === "Alice");
		expect(queen).toBeDefined();
		expect(queen.name).toBe("[Queen: Alice]");

		// Update responsibility dynamically on the server
		registry.updateResponsibility(king.id, "Updated Global Architecture v2");
		const updatedKing = registry.getAgent(king.id);
		expect(updatedKing?.responsibility).toBe("Updated Global Architecture v2");

		clientBob.close();
	});
});
