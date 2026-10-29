import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { hostSwarm, joinSwarm } from "../../../agentcord/src/swarm/app";
import type { HostedSwarm } from "../../../agentcord/src/swarm/app";
import { SwarmRunner } from "../../../agentcord/src/swarm/runner";
import { defaultSettings, ROLES } from "../../../agentcord/src/swarm/types";
import type { MemberSettings, Role, SwarmAgent, SwarmState, SwarmTask } from "../../../agentcord/src/swarm/types";
import type { MessageType, TestRunResult } from "../../../agentcord/src/types";
import { cfgModelRoles } from "../config/model-settings";
import type { AgentSession } from "../session/agent-session";

export interface AgentcordBridgeOptions {
	userName: string;
	isKing?: boolean;
	port?: number;
	session?: AgentSession;
	remoteRelayUrl?: string;
	directory?: string;
}

/** The terminal and browser use the same hub, settings, scheduler and real OMP runner. */
export class AgentcordBridge {
	#options: AgentcordBridgeOptions;
	#host?: HostedSwarm;
	#peer?: SwarmRunner;
	#state?: SwarmState;
	#memberId = "";
	#token = "";
	#url = "";
	#settings: MemberSettings;
	constructor(options: AgentcordBridgeOptions) {
		this.#options = options;
		this.#settings = defaultSettings(options.isKing ?? true);
		if (options.session) this.setSession(options.session);
	}
	get userName(): string {
		return this.#options.userName;
	}
	get isKing(): boolean {
		return this.#options.isKing ?? true;
	}
	get guiUrl(): string {
		return this.#url ? `${this.#url}/#token=${this.#token}` : "";
	}
	get queenAgent(): SwarmAgent | undefined {
		return this.#ownAgent("queen");
	}
	get kingAgent(): SwarmAgent | undefined {
		return this.#state?.agents.find(agent => agent.role === "king");
	}
	get workerAgent(): SwarmAgent | undefined {
		return this.#ownAgent("worker");
	}
	get testGenAgent(): SwarmAgent | undefined {
		return this.#ownAgent("testgen");
	}
	get testerAgent(): SwarmAgent | undefined {
		return this.#ownAgent("tester");
	}
	get #directory(): string {
		return path.resolve(this.#options.directory ?? path.join(process.cwd(), ".agentcord"));
	}
	#ownAgent(role: Role): SwarmAgent | undefined {
		return this.#state?.agents.find(agent => agent.role === role && agent.ownerId === this.#memberId);
	}
	setSession(session: AgentSession): void {
		this.#options.session = session;
		if (this.#url) return;
		const models = cfgModelRoles.get(session.settings);
		for (const role of ROLES) if (models[role]) this.#settings[role].model = models[role]!;
	}
	setUserName(name: string): void {
		if (this.#url) throw new Error("Reconnect with a separate member identity to change your room name");
		if (name.trim()) this.#options.userName = name.trim();
	}
	async start(port = this.#options.port ?? 7466): Promise<string> {
		if (this.#url) return this.guiUrl;
		if (this.#options.remoteRelayUrl) {
			if (!(await this.connect(this.#options.remoteRelayUrl)))
				throw new Error("Could not connect to the shared hub");
			return this.guiUrl;
		}
		if (!this.isKing) throw new Error("Join the king's room with /agentcord connect <invite-link>");
		this.#host = await hostSwarm({
			name: this.userName,
			directory: this.#directory,
			port,
			onError: message => logger.warn("Agentcord runner", { message }),
		});
		this.#url = this.#host.url;
		this.#token = this.#host.hub.hostToken;
		this.#memberId = this.#host.hub.state.hostId;
		if (!this.#host.hub.store.meta("omp-settings-seeded")) {
			this.#host.hub.updateSettings(this.#memberId, this.#settings);
			this.#host.hub.store.meta("omp-settings-seeded", "true");
		}
		this.#state = this.#host.hub.state;
		this.#host.hub.subscribe(state => {
			this.#state = structuredClone(state);
		});
		return this.guiUrl;
	}
	async connect(invite: string): Promise<boolean> {
		try {
			await this.stop();
			const credential = await joinSwarm(invite, this.userName, this.#directory);
			this.#url = credential.url;
			this.#token = credential.token;
			const snapshot = await this.#request<{ state: SwarmState; memberId: string }>("state");
			this.#state = snapshot.state;
			this.#memberId = snapshot.memberId;
			this.#peer = new SwarmRunner({
				url: this.#url,
				token: this.#token,
				directory: path.join(this.#directory, "terminal-runner", this.#memberId),
				onState: state => {
					this.#state = state;
				},
				onError: message => logger.warn("Agentcord runner", { message }),
			});
			await this.#peer.start();
			return true;
		} catch (error) {
			logger.error("Cannot join Agentcord", { error: String(error) });
			await this.stop();
			return false;
		}
	}
	async #request<T>(route: string, body?: unknown): Promise<T> {
		if (!this.#url) throw new Error("Start or join a swarm first with /agentcord gui or /agentcord connect");
		const response = await fetch(new URL(`/api/${route}`, this.#url), {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const result = await response.json();
		if (!response.ok) throw new Error((result as { error?: string }).error ?? `Hub returned ${response.status}`);
		return result as T;
	}
	async updateRoleModel(role: string, model: string): Promise<boolean> {
		if (!ROLES.includes(role as Role) || !model.trim()) return false;
		if (!this.#url) {
			this.#settings[role as Role].model = model.trim();
			return true;
		}
		const member = this.#state!.members.find(item => item.id === this.#memberId)!;
		const settings = structuredClone(member.settings);
		settings[role as Role].model = model.trim();
		await this.#request("settings", { settings });
		this.#state = (await this.#request<{ state: SwarmState }>("state")).state;
		return true;
	}
	getRoleModel(role: string): string {
		if (!ROLES.includes(role as Role)) return "unknown";
		return (
			this.#state?.members.find(item => item.id === this.#memberId)?.settings[role as Role].model ??
			this.#settings[role as Role].model
		);
	}
	async createWorker(specialty: string, responsibility: string): Promise<SwarmAgent> {
		if (!this.#state) throw new Error("Start the swarm first");
		const member = this.#state.members.find(item => item.id === this.#memberId)!;
		const settings = structuredClone(member.settings);
		settings.worker.count = settings.worker.enabled ? settings.worker.count + 1 : 1;
		settings.worker.enabled = true;
		settings.worker.instructions = `${specialty}: ${responsibility}`;
		await this.#request("settings", { settings });
		this.#state = (await this.#request<{ state: SwarmState }>("state")).state;
		return this.#state.agents.filter(agent => agent.ownerId === this.#memberId && agent.role === "worker").at(-1)!;
	}
	#target(target: string): SwarmAgent | undefined {
		return (
			this.#state?.agents.find(agent => agent.id === target || agent.name.toLowerCase() === target.toLowerCase()) ??
			(target === "king" ? this.kingAgent : this.#ownAgent(target as Role))
		);
	}
	async assignResponsibility(_from: string, target: string, instructions: string): Promise<boolean> {
		const agent = this.#target(target),
			project = this.#state?.projects[0];
		if (!agent || !project) return false;
		await this.#request("tasks", {
			projectId: project.id,
			agentId: agent.id,
			title: instructions.slice(0, 120),
			instructions,
		});
		return true;
	}
	async #wait(task: SwarmTask): Promise<SwarmTask> {
		const deadline = Date.now() + 60 * 60_000;
		while (Date.now() < deadline) {
			const { state } = await this.#request<{ state: SwarmState }>("state");
			this.#state = state;
			const current = state.tasks.find(item => item.id === task.id)!;
			if (!["queued", "running", "waiting", "integrating"].includes(current.status)) return current;
			await Bun.sleep(1000);
		}
		throw new Error(`Task ${task.id} is still pending. Follow it in the GUI.`);
	}
	async ask(target: string, question: string): Promise<string> {
		const agent = this.#target(target),
			project = this.#state?.projects[0];
		if (!agent || !project) throw new Error("Select an enabled agent and attach a project in the GUI first");
		const task = await this.#request<SwarmTask>("tasks", {
			projectId: project.id,
			agentId: agent.id,
			title: question.slice(0, 120),
			instructions: question,
		});
		const finished = await this.#wait(task);
		if (finished.status !== "completed") throw new Error(finished.error ?? finished.status);
		return finished.result ?? "";
	}
	async sendChat(kind: MessageType, target: string | undefined, content: string): Promise<void> {
		const to = kind === "dm" ? this.#target(target ?? "")?.id : undefined;
		if (kind === "dm" && !to) throw new Error("Direct message recipient is not an enabled agent");
		await this.#request("message", { text: content, to });
	}
	async runStepTest(
		description = "Verify the current project implementation",
	): Promise<{ testcases: string[]; result: TestRunResult }> {
		const project = this.#state?.projects[0],
			tester = this.testerAgent,
			testgen = this.testGenAgent;
		if (!project || !tester) throw new Error("Attach a project and enable your tester role first");
		let generation: SwarmTask | undefined;
		if (testgen)
			generation = await this.#request<SwarmTask>("tasks", {
				projectId: project.id,
				agentId: testgen.id,
				title: "Generate verification tests",
				instructions: description,
			});
		const task = await this.#request<SwarmTask>("tasks", {
			projectId: project.id,
			agentId: tester.id,
			title: "Run verification commands",
			instructions: description,
			dependsOn: generation ? [generation.id] : [],
		});
		const finished = await this.#wait(task);
		return {
			testcases: generation ? [(await this.#wait(generation)).result ?? ""] : [],
			result: {
				id: finished.id,
				testId: finished.id,
				testName: finished.title,
				passed: finished.status === "completed",
				step: 1,
				output: finished.result ?? finished.error ?? finished.status,
				executedAt: finished.updatedAt,
			},
		};
	}
	getResponsibilityMatrix() {
		return (
			this.#state?.agents.map(agent => {
				const task = this.#state!.tasks.find(item => item.agentId === agent.id && item.status === "running");
				return {
					agentId: agent.id,
					agentName: agent.name,
					role: agent.role,
					responsibility: task?.title ?? "Available",
					status: agent.online ? (task?.status ?? "idle") : "offline",
					updatedAt: task?.updatedAt ?? 0,
				};
			}) ?? []
		);
	}
	getStatusSummary(): string {
		if (!this.#url)
			return "Agentcord is not running. Use /agentcord gui to host, or /agentcord connect <invite-link> to join.";
		return [
			`Agentcord: ${this.userName} · ${this.#url}`,
			...this.getResponsibilityMatrix().map(
				agent => `${agent.agentName}: ${agent.status} · ${agent.responsibility}`,
			),
		].join("\n");
	}
	async stop(): Promise<void> {
		await this.#peer?.stop();
		await this.#host?.stop();
		this.#peer = undefined;
		this.#host = undefined;
		this.#state = undefined;
		this.#url = "";
		this.#token = "";
	}
}

let activeBridge: AgentcordBridge | undefined;
export function getActiveAgentcordBridge(): AgentcordBridge | undefined {
	return activeBridge;
}
export function setActiveAgentcordBridge(bridge: AgentcordBridge): void {
	activeBridge = bridge;
}
