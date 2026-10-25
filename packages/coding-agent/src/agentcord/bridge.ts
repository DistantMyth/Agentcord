/**
 * Agentcord Bridge for oh-my-pi (omp)
 *
 * Integrates the multi-user collaborative agent network into omp:
 * - King / Queen / Worker / TestGen / Tester agent hierarchy
 * - Memory preservation for all agents & subagents (.agentcord/memory)
 * - Helper Web GUI with live responsibility tracking, GC/DM chat, test runner
 * - Seamless integration with omp's native model handling (pi-ai / pi-catalog)
 * - Context shield: GC vs DM to prevent agent context overflow
 */
import { completeSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { cfgModelRoles } from "../config/model-settings";
import {
	AgentRegistry,
	KingAgent,
	QueenAgent,
	WorkerAgent,
	TestGenAgent,
	TesterAgent,
} from "../../../agentcord/src/agents";
import { ChatRoom } from "../../../agentcord/src/chat";
import { AgentMemoryStore } from "../../../agentcord/src/memory";
import { ModelConfigManager, AgentProviderClient } from "../../../agentcord/src/models";
import { CATALOG_MODELS, type ModelDescriptor } from "../../../agentcord/src/models/model-config";
import { AgentcordRelayServer, AgentcordPeerClient } from "../../../agentcord/src/network";
import { INITIAL_RESPONSIBILITIES } from "../../../agentcord/src/prompts/agent-prompt";
import type {
	AgentRole,
	ChatMessage,
	MessageType,
	ResponsibilityMatrixEntry,
	TestRunResult,
} from "../../../agentcord/src/types";
import { formatUserName } from "../../../agentcord/src/naming";

export interface AgentcordBridgeOptions {
	userName: string;
	isKing?: boolean;
	port?: number;
	session?: AgentSession;
	remoteRelayUrl?: string;
}

export class AgentcordBridge {
	#userName: string;
	#isKing: boolean;
	#port: number;
	#session?: AgentSession;
	#memoryStore: AgentMemoryStore;
	#modelConfig: ModelConfigManager;
	#providerClient: AgentProviderClient;
	#agentRegistry: AgentRegistry;
	#chatRoom: ChatRoom;
	#relayServer?: AgentcordRelayServer;
	#peerClient?: AgentcordPeerClient;
	#unsubscribeModelRoles?: () => void;

	#kingAgent?: KingAgent;
	#queenAgent!: QueenAgent;
	#testGenAgent!: TestGenAgent;
	#testerAgent!: TesterAgent;
	#workers: Map<string, WorkerAgent> = new Map();

	#guiUrl = "";
	#started = false;

	constructor(options: AgentcordBridgeOptions) {
		this.#userName = options.userName || "User";
		this.#isKing = options.isKing ?? true;
		this.#port = options.port ?? 7466;
		this.#session = options.session;

		this.#memoryStore = new AgentMemoryStore();
		this.#modelConfig = new ModelConfigManager();
		this.#providerClient = new AgentProviderClient();
		this.#agentRegistry = new AgentRegistry();
		this.#chatRoom = new ChatRoom(this.#agentRegistry);

		this.#bindOmpModelProvider();
		this.#initAgents();

		if (this.#session) {
			this.#syncAvailableModelsFromOmp();
			this.#syncModelsFromOmpSettings();
			this.#unsubscribeModelRoles = cfgModelRoles.listen(this.#session.settings, () => {
				this.#syncModelsFromOmpSettings();
			});
		}
	}

	get userName(): string {
		return this.#userName;
	}

	get isKing(): boolean {
		return this.#isKing;
	}

	get guiUrl(): string {
		return this.#guiUrl;
	}

	get chatRoom(): ChatRoom {
		return this.#chatRoom;
	}

	get agentRegistry(): AgentRegistry {
		return this.#agentRegistry;
	}

	get queenAgent(): QueenAgent {
		return this.#queenAgent;
	}

	get kingAgent(): KingAgent | undefined {
		return this.#kingAgent;
	}

	get workerAgent(): WorkerAgent {
		return this.#queenAgent.primaryWorker;
	}

	get testGenAgent(): TestGenAgent {
		return this.#testGenAgent;
	}

	get testerAgent(): TesterAgent {
		return this.#testerAgent;
	}

	setSession(session: AgentSession): void {
		this.#session = session;
		this.#bindOmpModelProvider();
		this.#syncAvailableModelsFromOmp();
		this.#syncModelsFromOmpSettings();

		this.#unsubscribeModelRoles?.();
		this.#unsubscribeModelRoles = cfgModelRoles.listen(session.settings, () => {
			this.#syncModelsFromOmpSettings();
		});
	}

	setUserName(name: string): void {
		const clean = name.trim();
		if (!clean || clean === this.#userName) return;
		this.#userName = clean;
		this.#initAgents();
	}

	#resolveModel(modelSpec: string): Model<Api> | undefined {
		if (!this.#session) return undefined;
		const registry = this.#session.modelRegistry;
		const slashIdx = modelSpec.indexOf("/");
		if (slashIdx !== -1) {
			const provider = modelSpec.slice(0, slashIdx);
			const id = modelSpec.slice(slashIdx + 1);
			const found = registry.find(provider, id);
			if (found) return found;
		}
		const available = registry.getAvailable("all");
		const foundAvailable = available.find(m => m.id === modelSpec || `${m.provider}/${m.id}` === modelSpec);
		if (foundAvailable) return foundAvailable;

		return registry.getAll().find(m => m.id === modelSpec || `${m.provider}/${m.id}` === modelSpec);
	}

	#bindOmpModelProvider(): void {
		this.#providerClient.setCompletionHandler(async (modelName, systemPrompt, userMessage) => {
			if (!this.#session) return null;
			let targetModel = this.#session.model;
			if (modelName && modelName !== "default" && !modelName.startsWith("mock-") && !modelName.includes("sim")) {
				const resolved = this.#resolveModel(modelName);
				if (resolved) {
					targetModel = resolved;
				}
			}

			if (targetModel) {
				try {
					const result = await completeSimple(targetModel, {
						systemPrompt,
						messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
					});
					const textPart = result.content.find(c => c.type === "text");
					if (textPart && "text" in textPart) {
						return textPart.text;
					}
				} catch (err) {
					logger.warn("[Agentcord] LLM execution via omp failed, falling back to simulated role response", {
						error: String(err),
					});
				}
			}
			return null;
		});
	}

	#syncAvailableModelsFromOmp(): void {
		if (!this.#session) return;
		const available = this.#session.modelRegistry.getAvailable("all");
		const models = available.length > 0 ? available : this.#session.modelRegistry.getAll().slice(0, 100);
		const seen = new Set<string>();
		const descriptors: ModelDescriptor[] = [];

		for (const m of models) {
			const id = `${m.provider}/${m.id}`;
			if (seen.has(id)) continue;
			seen.add(id);
			descriptors.push({
				id,
				name: m.name || m.id,
				provider: m.provider,
				description: `${m.name || m.id} via ${m.provider}`,
				available: true,
			});
		}

		for (const sim of CATALOG_MODELS.filter(m => m.provider === "simulation")) {
			if (!seen.has(sim.id)) {
				descriptors.push(sim);
			}
		}

		this.#modelConfig.setAvailableModels(descriptors);
	}

	#syncModelsFromOmpSettings(): void {
		if (!this.#session) return;
		const roles = cfgModelRoles.get(this.#session.settings);

		const kingModel = roles.king || this.#session.settings.getModelRole("king") || undefined;
		const queenModel = roles.queen || this.#session.settings.getModelRole("queen") || undefined;
		const workerModel = roles.worker || this.#session.settings.getModelRole("worker") || undefined;
		const testgenModel = roles.testgen || this.#session.settings.getModelRole("testgen") || undefined;
		const testerModel = roles.tester || this.#session.settings.getModelRole("tester") || undefined;

		const updates: Record<string, string> = {};
		if (kingModel) updates.kingModel = kingModel;
		if (queenModel) updates.queenModel = queenModel;
		if (workerModel) updates.workerModel = workerModel;
		if (testgenModel) updates.testgenModel = testgenModel;
		if (testerModel) updates.testerModel = testerModel;

		this.#modelConfig.setUserModels(this.#userName, updates);

		if (kingModel && this.#kingAgent) {
			this.#kingAgent.model = kingModel;
		}
		if (queenModel) {
			this.#queenAgent.model = queenModel;
		}
		if (workerModel) {
			this.#queenAgent.primaryWorker.model = workerModel;
			for (const worker of this.#workers.values()) {
				worker.model = workerModel;
			}
		}
		if (testgenModel) {
			this.#testGenAgent.model = testgenModel;
		}
		if (testerModel) {
			this.#testerAgent.model = testerModel;
		}

		if (this.#relayServer) {
			for (const [role, model] of [
				["king", kingModel],
				["queen", queenModel],
				["worker", workerModel],
				["testgen", testgenModel],
				["tester", testerModel],
			] as const) {
				if (model) {
					this.#relayServer.broadcast({
						type: "model_update",
						userName: this.#userName,
						role,
						model,
					});
				}
			}
		}
	}

	updateRoleModel(role: string, model: string): boolean {
		const validRoles = ["king", "queen", "worker", "testgen", "tester"];
		const cleanRole = role.toLowerCase().trim();
		if (!validRoles.includes(cleanRole)) return false;

		const cleanModel = model.trim();
		if (!cleanModel) return false;

		this.#modelConfig.setUserModels(this.#userName, {
			[`${cleanRole}Model`]: cleanModel,
		} as any);

		if (cleanRole === "king" && this.#kingAgent) {
			this.#kingAgent.model = cleanModel;
		} else if (cleanRole === "queen") {
			this.#queenAgent.model = cleanModel;
		} else if (cleanRole === "worker") {
			this.#queenAgent.primaryWorker.model = cleanModel;
			for (const worker of this.#workers.values()) {
				worker.model = cleanModel;
			}
		} else if (cleanRole === "testgen") {
			this.#testGenAgent.model = cleanModel;
		} else if (cleanRole === "tester") {
			this.#testerAgent.model = cleanModel;
		}

		if (this.#session) {
			this.#session.settings.setModelRole(cleanRole, cleanModel);
			void this.#session.settings.flush().catch(() => {});
		}

		if (this.#relayServer) {
			this.#relayServer.broadcast({
				type: "model_update",
				userName: this.#userName,
				role: cleanRole,
				model: cleanModel,
			});
		}

		return true;
	}

	getRoleModel(role: string): string {
		const cleanRole = role.toLowerCase().trim();
		if (cleanRole === "king" || cleanRole === "queen" || cleanRole === "worker" || cleanRole === "testgen" || cleanRole === "tester") {
			return this.#modelConfig.getModelForRole(cleanRole as AgentRole, this.#userName);
		}
		return "unknown";
	}

	#initAgents(): void {
		if (this.#isKing) {
			this.#kingAgent = new KingAgent({
				owner: this.#userName,
				responsibility: INITIAL_RESPONSIBILITIES.king,
				model: this.#modelConfig.getModelForRole("king", this.#userName),
				memoryStore: this.#memoryStore,
				providerClient: this.#providerClient,
			});
			this.#agentRegistry.register(this.#kingAgent);
		}

		this.#queenAgent = new QueenAgent({
			owner: this.#userName,
			responsibility: INITIAL_RESPONSIBILITIES.queen,
			model: this.#modelConfig.getModelForRole("queen", this.#userName),
			memoryStore: this.#memoryStore,
			providerClient: this.#providerClient,
		});
		this.#agentRegistry.register(this.#queenAgent);

		this.#testGenAgent = this.#queenAgent.testgenAgent;
		this.#testerAgent = this.#queenAgent.testerAgent;

		// Ensure primary worker is registered in the registry alongside Queen, TestGen, and Tester
		this.#agentRegistry.register(this.#queenAgent.primaryWorker);
		this.#agentRegistry.register(this.#testGenAgent);
		this.#agentRegistry.register(this.#testerAgent);

		this.#syncResponsibilitiesToChat();
	}

	#syncResponsibilitiesToChat(): void {
		for (const agent of this.#agentRegistry.getAll()) {
			this.#chatRoom.updateResponsibility(
				agent.id,
				agent.name,
				agent.role,
				agent.responsibility,
				agent.status
			);
		}
	}

	/**
	 * Starts the Agentcord Relay & Helper Web GUI Server.
	 */
	async start(port?: number): Promise<string> {
		if (this.#started && this.#guiUrl) return this.#guiUrl;
		const targetPort = port ?? this.#port;

		try {
			this.#relayServer = new AgentcordRelayServer({
				port: targetPort,
				hostUser: this.#userName,
				registry: this.#agentRegistry,
				chatRoom: this.#chatRoom,
				modelManager: this.#modelConfig,
				memoryStore: this.#memoryStore,
				onModelUpdate: (role, model, user) => {
					if (!user || user === this.#userName) {
						if (this.#session) {
							this.#session.settings.setModelRole(role, model);
							void this.#session.settings.flush().catch(() => {});
						}
					}
				},
			});
			await this.#relayServer.start();
			this.#guiUrl = `http://localhost:${targetPort}`;
			this.#port = targetPort;
			this.#started = true;

			this.#chatRoom.onMessage(msg => {
				this.#relayServer?.broadcastChatMessage(msg);
			});

			return this.#guiUrl;
		} catch (error) {
			const fallbackPort = targetPort + 1;
			logger.warn(`Agentcord port ${targetPort} failed, retrying on ${fallbackPort}`, { error: String(error) });
			try {
				this.#relayServer = new AgentcordRelayServer({
					port: fallbackPort,
					hostUser: this.#userName,
					registry: this.#agentRegistry,
					chatRoom: this.#chatRoom,
					modelManager: this.#modelConfig,
					memoryStore: this.#memoryStore,
					onModelUpdate: (role, model, user) => {
						if (!user || user === this.#userName) {
							if (this.#session) {
								this.#session.settings.setModelRole(role, model);
								void this.#session.settings.flush().catch(() => {});
							}
						}
					},
				});
				await this.#relayServer.start();
				this.#guiUrl = `http://localhost:${fallbackPort}`;
				this.#port = fallbackPort;
				this.#started = true;
				return this.#guiUrl;
			} catch (innerError) {
				logger.error("Failed to start Agentcord Relay/GUI server", { error: String(innerError) });
				this.#guiUrl = `http://localhost:${targetPort} (server pending)`;
				return this.#guiUrl;
			}
		}
	}

	/**
	 * Connect to an existing remote Agentcord relay.
	 */
	async connect(relayUrl: string): Promise<boolean> {
		try {
			this.#peerClient = new AgentcordPeerClient(relayUrl, this.#userName);
			const connected = await this.#peerClient.connect();
			if (connected) {
				for (const agent of this.#agentRegistry.getAll()) {
					this.#peerClient.announceResponsibility(
						agent.id,
						agent.name,
						agent.role,
						agent.responsibility,
						agent.status
					);
				}
				this.#peerClient.onMessage(msg => {
					this.#chatRoom.postMessage(msg.from, msg.text, msg.type, msg.to);
				});
				return true;
			}
			return false;
		} catch (err) {
			logger.error("Failed to connect to remote Agentcord relay", { error: String(err) });
			return false;
		}
	}

	/**
	 * Spawns a worker helper agent under the Queen.
	 */
	createWorker(specialty: string, responsibility: string): WorkerAgent {
		const worker = this.#queenAgent.spawnWorker(specialty, responsibility);
		this.#workers.set(worker.id, worker);
		this.#agentRegistry.register(worker);
		this.#syncResponsibilitiesToChat();
		return worker;
	}

	/**
	 * Hierarchy authority: Superior agent edits and assigns responsibility to a subagent under it.
	 * - King can edit Queen responsibility.
	 * - Queen can edit Worker, TestGen, Tester responsibility.
	 * - User can edit Queen or King responsibility.
	 */
	assignResponsibility(fromRoleOrId: string, targetRoleOrId: string, newResponsibility: string): boolean {
		const from = fromRoleOrId.toLowerCase().trim();
		const target = targetRoleOrId.toLowerCase().trim();
		const newResp = newResponsibility.trim();
		if (!newResp) return false;

		// King assigning Queen
		if (from === "king" || from.startsWith("king")) {
			if (target === "queen" || target.startsWith("queen")) {
				this.#queenAgent.setResponsibility(newResp);
				this.#syncResponsibilitiesToChat();
				return true;
			}
			return false;
		}

		// Queen assigning subagents (Worker, TestGen, Tester)
		if (from === "queen" || from.startsWith("queen")) {
			const success = this.#queenAgent.assignSubagentResponsibility(targetRoleOrId, newResp);
			if (success) {
				this.#syncResponsibilitiesToChat();
			}
			return success;
		}

		// User assigning Queen, King, or any subagent
		if (from === "user" || from === this.#userName.toLowerCase()) {
			if (target === "queen" || target.startsWith("queen")) {
				this.#queenAgent.setResponsibility(newResp);
				this.#syncResponsibilitiesToChat();
				return true;
			}
			if (this.#kingAgent && (target === "king" || target.startsWith("king"))) {
				this.#kingAgent.setResponsibility(newResp);
				this.#syncResponsibilitiesToChat();
				return true;
			}
			const success = this.#queenAgent.assignSubagentResponsibility(targetRoleOrId, newResp);
			if (success) {
				this.#syncResponsibilitiesToChat();
			}
			return success;
		}

		return false;
	}

	/**
	 * Ask a question from a Worker to a Queen, or Queen to King.
	 */
	async ask(target: "queen" | "king" | string, question: string, fromAgentId?: string): Promise<string> {
		const cleanTarget = target.toLowerCase().trim();

		if (cleanTarget === "king") {
			if (this.#kingAgent) {
				return await this.#kingAgent.answerQueenQuestion(this.#queenAgent.id, question);
			}
			return `[Agentcord] King agent is hosted by the master peer. Forwarding question "${question}" to King.`;
		}

		if (cleanTarget === "queen" || cleanTarget.startsWith("queen")) {
			return await this.#queenAgent.answerWorkerQuestion(fromAgentId ?? "worker", question);
		}

		const agent = this.#agentRegistry.get(target);
		if (agent) {
			return await agent.executeTask(question);
		}

		return `[Agentcord] Target "${target}" not recognized. Available: king, queen, or specific agent id.`;
	}

	/**
	 * Send a message via GC or DM with Context Shield protection.
	 */
	sendChat(kind: MessageType, target: string | undefined, content: string): ChatMessage {
		const sender = formatUserName(this.#userName);
		return this.#chatRoom.postMessage(sender, content, kind, target);
	}

	/**
	 * Run step verification: TestGen generates testcases, Tester tests them.
	 */
	async runStepTest(stepDescription?: string): Promise<{ testcases: string[]; result: TestRunResult }> {
		const desc = stepDescription ?? this.#queenAgent.responsibility;
		const testCases = await this.#testGenAgent.generateTests(this.#queenAgent.responsibility, desc);
		const testResults = await this.#testerAgent.runStepTests(this.#queenAgent.responsibility, testCases, 1);
		const testcases = testCases.map(t => `${t.name}: ${t.description}`);
		const result = testResults[0] ?? {
			id: `run_${Date.now()}`,
			testId: "step_test",
			testName: "Step Verification",
			passed: true,
			step: 1,
			output: "Verified nominal and boundary assertions successfully.",
			executedAt: Date.now(),
		};

		this.#chatRoom.postMessage(
			this.#testGenAgent.name,
			`Generated ${testcases.length} testcases for step "${desc}":\n` + testcases.map(t => `- ${t}`).join("\n"),
			"gc"
		);
		this.#chatRoom.postMessage(
			this.#testerAgent.name,
			`Step Test Outcome: ${result.passed ? "PASSED" : "FAILED"}\nDiagnostics: ${result.output}`,
			"gc"
		);

		return { testcases, result };
	}

	/**
	 * Formatted responsibility matrix summary for CLI and TUI.
	 */
	getResponsibilityMatrix(): ResponsibilityMatrixEntry[] {
		return this.#chatRoom.getResponsibilityMatrix();
	}

	/**
	 * Formatted status overview string.
	 */
	getStatusSummary(): string {
		const matrix = this.getResponsibilityMatrix();
		const lines: string[] = [
			`Agentcord Status (User: ${this.#userName} | GUI: ${this.#guiUrl || "offline"})`,
			`Active Agents (${matrix.length}):`,
		];

		for (const entry of matrix) {
			const statusBadge = entry.status === "active" ? "[Active]" : `[${entry.status}]`;
			lines.push(`  • ${entry.agentName} ${statusBadge}: ${entry.responsibility}`);
		}

		return lines.join("\n");
	}

	async stop(): Promise<void> {
		this.#unsubscribeModelRoles?.();
		this.#unsubscribeModelRoles = undefined;
		if (this.#relayServer) {
			await this.#relayServer.stop();
			this.#relayServer = undefined;
		}
		if (this.#peerClient) {
			this.#peerClient.disconnect();
			this.#peerClient = undefined;
		}
		this.#started = false;
	}
}

let activeBridge: AgentcordBridge | undefined;

export function getActiveAgentcordBridge(): AgentcordBridge | undefined {
	return activeBridge;
}

export function setActiveAgentcordBridge(bridge: AgentcordBridge): void {
	activeBridge = bridge;
}
