import { describe, expect, test, afterAll } from "bun:test";
import { MODEL_ROLE_IDS, CHAT_MODEL_ROLE_IDS } from "../../tui/src/overlays/model-browser";
import { MODEL_ROLES } from "../../coding-agent/src/config/model-roles";
import { AgentcordBridge } from "../../coding-agent/src/agentcord/bridge";
import { AgentcordRelayServer } from "../src/network/relay-server";
import { AgentRegistry } from "../src/agents";
import { ChatRoom } from "../src/chat";
import { ModelConfigManager } from "../src/models";
import { AgentMemoryStore } from "../src/memory";

describe("Agentcord Model Roles & omp Native Integration", () => {
	test("omp ModelRole and CHAT_MODEL_ROLE_IDS includes all Agentcord hierarchy roles", () => {
		const roles = ["king", "queen", "worker", "testgen", "tester"] as const;
		for (const role of roles) {
			expect(MODEL_ROLE_IDS).toContain(role);
			expect(CHAT_MODEL_ROLE_IDS).toContain(role);
			expect(MODEL_ROLES[role]).toBeDefined();
			expect(MODEL_ROLES[role].tag).toBe(role.toUpperCase());
			expect(MODEL_ROLES[role].section).toBe("chat");
		}
	});

	test("AgentcordBridge gets and updates role models cleanly", () => {
		const bridge = new AgentcordBridge({
			userName: "Bob",
			isKing: true,
			port: 8599,
		});

		// Verify initial role models
		expect(bridge.getRoleModel("king")).toBe("claude-3-7-sonnet");
		expect(bridge.getRoleModel("queen")).toBe("gemini-2.5-pro");
		expect(bridge.getRoleModel("worker")).toBe("claude-3-5-haiku");
		expect(bridge.getRoleModel("testgen")).toBe("gemini-2.5-flash");
		expect(bridge.getRoleModel("tester")).toBe("mock-sim-fast");

		// Update queen model
		const updated = bridge.updateRoleModel("queen", "openai/gpt-4o");
		expect(updated).toBe(true);
		expect(bridge.getRoleModel("queen")).toBe("openai/gpt-4o");
		expect(bridge.queenAgent.model).toBe("openai/gpt-4o");

		// Update worker model
		bridge.updateRoleModel("worker", "anthropic/claude-3-5-sonnet");
		expect(bridge.getRoleModel("worker")).toBe("anthropic/claude-3-5-sonnet");
		expect(bridge.workerAgent.model).toBe("anthropic/claude-3-5-sonnet");

		// Invalid role rejection
		const invalid = bridge.updateRoleModel("invalid_role", "some/model");
		expect(invalid).toBe(false);
	});

	test("AgentcordRelayServer /api/models returns available models and current role assignments", async () => {
		const registry = new AgentRegistry();
		const chatRoom = new ChatRoom(registry);
		const modelManager = new ModelConfigManager();
		const memoryStore = new AgentMemoryStore();

		modelManager.setUserModels("Carol", {
			kingModel: "anthropic/claude-3-7-sonnet",
			queenModel: "google/gemini-2.5-pro",
		});

		let capturedRole = "";
		let capturedModel = "";

		const server = new AgentcordRelayServer({
			port: 8699,
			hostUser: "Carol",
			registry,
			chatRoom,
			modelManager,
			memoryStore,
			onModelUpdate: (role, model) => {
				capturedRole = role;
				capturedModel = model;
			},
		});

		await server.start();

		try {
			const res = await fetch("http://localhost:8699/api/models");
			expect(res.status).toBe(200);
			const data = (await res.json()) as any;

			expect(data.available).toBeDefined();
			expect(Array.isArray(data.available)).toBe(true);
			expect(data.available.length).toBeGreaterThan(0);

			expect(data.current).toBeDefined();
			expect(data.current.king).toBe("anthropic/claude-3-7-sonnet");
			expect(data.current.queen).toBe("google/gemini-2.5-pro");
		} finally {
			server.stop();
		}
	});
});
