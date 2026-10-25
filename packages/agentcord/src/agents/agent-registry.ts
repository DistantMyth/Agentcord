import type { AgentInfo, AgentRole, AgentStatus } from "../types";
import type { BaseAgent } from "./base-agent";
import type { KingAgent } from "./king-agent";
import type { QueenAgent } from "./queen-agent";

export type RegistryListener = (agents: AgentInfo[]) => void;

export class AgentRegistry {
	private readonly agents = new Map<string, BaseAgent>();
	private readonly listeners = new Set<RegistryListener>();

	registerAgent(agent: BaseAgent): void {
		this.agents.set(agent.id, agent);
		this.notify();
	}

	register(agent: BaseAgent): void {
		this.registerAgent(agent);
	}

	get(agentId: string): BaseAgent | undefined {
		return this.getAgent(agentId);
	}

	getAll(): BaseAgent[] {
		return Array.from(this.agents.values());
	}

	unregisterAgent(agentId: string): void {
		if (this.agents.delete(agentId)) {
			this.notify();
		}
	}

	getAgent(agentId: string): BaseAgent | undefined {
		return this.agents.get(agentId);
	}

	findAgentByName(name: string): BaseAgent | undefined {
		const target = name.trim().toLowerCase();
		for (const agent of this.agents.values()) {
			if (agent.name.toLowerCase() === target || agent.id.toLowerCase() === target) {
				return agent;
			}
		}
		return undefined;
	}

	getKing(): KingAgent | undefined {
		for (const agent of this.agents.values()) {
			if (agent.role === "king") return agent as KingAgent;
		}
		return undefined;
	}

	getQueens(): QueenAgent[] {
		const list: QueenAgent[] = [];
		for (const agent of this.agents.values()) {
			if (agent.role === "queen") list.push(agent as QueenAgent);
		}
		return list;
	}

	getAgentsByOwner(owner: string): BaseAgent[] {
		const list: BaseAgent[] = [];
		for (const agent of this.agents.values()) {
			if (agent.owner.toLowerCase() === owner.toLowerCase()) {
				list.push(agent);
			}
		}
		return list;
	}

	updateResponsibility(agentId: string, responsibility: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		if (agent.responsibility !== responsibility) {
			agent.setResponsibility(responsibility);
		}
		this.notify();
		return true;
	}

	updateStatus(agentId: string, status: AgentStatus): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		agent.setStatus(status);
		this.notify();
		return true;
	}

	updateModel(agentId: string, model: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		agent.setModel(model);
		this.notify();
		return true;
	}

	getSnapshots(): AgentInfo[] {
		return Array.from(this.agents.values()).map(a => a.getSnapshot());
	}

	getResponsibilityMatrix(): ResponsibilityMatrixEntry[] {
		return Array.from(this.agents.values()).map(a => ({
			agentId: a.id,
			agentName: a.name,
			role: a.role,
			responsibility: a.responsibility,
			status: a.status,
			updatedAt: a.lastActiveAt,
		}));
	}

	subscribe(listener: RegistryListener): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshots());
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		const snapshots = this.getSnapshots();
		for (const listener of this.listeners) {
			try {
				listener(snapshots);
			} catch (err) {
				console.error("Error in AgentRegistry listener:", err);
			}
		}
	}
}
