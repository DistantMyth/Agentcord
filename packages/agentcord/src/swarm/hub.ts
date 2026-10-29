import type { ProjectRepository } from "./repository";
import { SwarmStore } from "./store";
import {
	defaultSettings,
	errorText,
	isPlanner,
	normalizePaths,
	pathInScope,
	pathsOverlap,
	ROLES,
	swarmId,
} from "./types";
import type {
	Activity,
	Assignment,
	Member,
	MemberSettings,
	SwarmAgent,
	SwarmState,
	SwarmTask,
	TaskInput,
} from "./types";

interface RunnerConnection {
	send(assignment: Assignment): void;
	close(): void;
	lastHeartbeat: number;
}
interface Lease {
	token: string;
	memberId: string;
	connection: RunnerConnection;
}
type Listener = (state: SwarmState, event: Activity) => void;

export class SwarmHub {
	readonly store: SwarmStore;
	readonly hostToken: string;
	readonly inviteToken: string;
	#state: SwarmState;
	#repository: ProjectRepository;
	#runners = new Map<string, RunnerConnection>();
	#leases = new Map<string, Lease>();
	#listeners = new Set<Listener>();
	#integrations: Promise<void> = Promise.resolve();
	#closing = false;

	constructor(store: SwarmStore, repository: ProjectRepository, hostName: string) {
		this.store = store;
		this.#repository = repository;
		this.hostToken = store.meta("hostToken", crypto.randomUUID() + crypto.randomUUID())!;
		this.inviteToken = store.meta("inviteToken", crypto.randomUUID() + crypto.randomUUID())!;
		const saved = store.load();
		const hostId = saved?.hostId ?? crypto.randomUUID();
		this.#state = saved ?? {
			version: 2,
			roomId: crypto.randomUUID(),
			hostId,
			members: [{ id: hostId, name: hostName, isHost: true, online: false, settings: defaultSettings(true) }],
			agents: [],
			projects: [],
			tasks: [],
		};
		for (const member of this.#state.members) member.online = false;
		for (const task of this.#state.tasks) {
			if (task.status === "running" || task.status === "integrating") {
				if (task.status === "integrating") {
					const project = this.#state.projects.find(item => item.id === task.projectId);
					if (project) {
						project.status = "error";
						project.error =
							"Hub restarted during integration. Reconcile the preserved integration checkout before resuming.";
					}
				}
				task.status = "interrupted";
				task.error =
					"Hub restarted. Previous workspace and branch are preserved; retry explicitly after reviewing them.";
			}
		}
		store.setCredential(hostId, this.hostToken);
		this.#topology();
		store.save(this.#state);
	}
	get state(): SwarmState {
		return structuredClone(this.#state);
	}
	authenticate(token: string): string {
		const memberId = this.store.authenticate(token);
		if (!memberId) throw new Error("Unauthorized: invalid member token");
		return memberId;
	}
	join(name: string, invite: string): { token: string; member: Member } {
		if (invite !== this.inviteToken) throw new Error("Unauthorized: invalid invite");
		const clean = name.trim();
		if (!clean || clean.length > 60 || /[\x00-\x1f[\]]/.test(clean))
			throw new Error("Choose a name of 1–60 characters without control characters or brackets");
		if (this.#state.members.some(member => member.name.toLowerCase() === clean.toLowerCase()))
			throw new Error(
				"That name is already registered. Use the existing member token to reconnect, or choose another name.",
			);
		const member: Member = {
			id: crypto.randomUUID(),
			name: clean,
			isHost: false,
			online: false,
			settings: defaultSettings(),
		};
		const token = crypto.randomUUID() + crypto.randomUUID();
		this.#state.members.push(member);
		this.store.setCredential(member.id, token);
		this.#topology();
		this.#publish({ kind: "room", memberId: member.id, text: `${clean} joined the swarm` });
		return { token, member: structuredClone(member) };
	}
	#member(id: string): Member {
		const member = this.#state.members.find(item => item.id === id);
		if (!member) throw new Error("Member does not exist");
		return member;
	}
	updateSettings(memberId: string, input: unknown): void {
		const member = this.#member(memberId);
		if (!input || typeof input !== "object") throw new Error("Invalid role settings");
		const settings = input as MemberSettings;
		for (const role of ROLES) {
			const value = settings[role];
			if (
				!value ||
				typeof value.enabled !== "boolean" ||
				typeof value.model !== "string" ||
				!value.model.trim() ||
				value.model.length > 200 ||
				!Number.isInteger(value.count) ||
				value.count < 1 ||
				value.count > (role === "worker" ? 16 : 1) ||
				typeof value.instructions !== "string" ||
				value.instructions.length > 10000
			)
				throw new Error(`Invalid settings for ${role}`);
			if (role === "king" && value.enabled !== member.isHost)
				throw new Error("The host owns the project's single king; other members cannot enable a king");
		}
		if (
			this.#state.tasks.some(
				task =>
					["running", "integrating"].includes(task.status) &&
					this.#state.agents.find(agent => agent.id === task.agentId)?.ownerId === memberId,
			)
		)
			throw new Error("Wait for your running tasks to finish before changing role settings");
		member.settings = structuredClone(settings);
		this.#topology();
		this.#publish({ kind: "room", memberId, text: `${member.name} updated their roles and models` });
		this.schedule();
	}
	#topology(): void {
		const agents: SwarmAgent[] = [];
		for (const member of this.#state.members) {
			for (const role of ROLES) {
				const settings = member.settings[role];
				if (!settings.enabled || (role === "king" && !member.isHost)) continue;
				for (let index = 0; index < settings.count; index++)
					agents.push({
						id: `${member.id}:${role}:${index}`,
						ownerId: member.id,
						name: `${role} · ${member.name}${role === "worker" ? ` · ${index + 1}` : ""}`,
						role,
						model: settings.model,
						online: member.online,
					});
			}
		}
		const king = agents.find(agent => agent.role === "king")!;
		const queens = agents.filter(agent => agent.role === "queen" && agent.online);
		const loads = new Map(queens.map(queen => [queen.id, 0]));
		// Reserve each online queen's own agents first, then distribute orphaned agents by load.
		for (const agent of agents) {
			if (agent.role === "king") continue;
			if (agent.role === "queen") {
				agent.parentId = king.id;
				continue;
			}
			const own = queens.find(queen => queen.ownerId === agent.ownerId);
			if (own) {
				agent.parentId = own.id;
				loads.set(own.id, loads.get(own.id)! + 1);
			}
		}
		for (const agent of agents) {
			if (agent.role === "king" || agent.parentId) continue;
			const parent = [...queens].sort((a, b) => loads.get(a.id)! - loads.get(b.id)! || a.id.localeCompare(b.id))[0];
			agent.parentId = parent?.id ?? king.id;
			if (parent) loads.set(parent.id, loads.get(parent.id)! + 1);
		}
		this.#state.agents = agents;
	}

	async attachProject(
		memberId: string,
		directory: string,
		name: string,
		baseRef: string,
		remote = "origin",
	): Promise<void> {
		if (memberId !== this.#state.hostId) throw new Error("Only the host can attach a repository on the host machine");
		if (
			!directory ||
			!name ||
			!baseRef ||
			[baseRef, remote].some(value => value.startsWith("-") || /[\x00-\x20]/.test(value))
		)
			throw new Error("Provide a repository directory, name, base revision, and valid remote name");
		const project = await this.#repository.attach(directory, swarmId(), name, baseRef, remote);
		this.#state.projects.push(project);
		this.#publish({
			kind: "repository",
			projectId: project.id,
			text: `${name}: integration branch published at ${project.head}`,
		});
	}
	async reconcileProject(memberId: string, projectId: string): Promise<void> {
		if (memberId !== this.#state.hostId) throw new Error("Only the host may reconcile project integration");
		const project = this.#state.projects.find(item => item.id === projectId);
		if (!project || !this.#repository.reconcile) throw new Error("Project cannot be reconciled");
		if (
			this.#state.tasks.some(
				task => task.projectId === projectId && ["running", "integrating"].includes(task.status),
			)
		)
			throw new Error("Wait for running project tasks before reconciling");
		project.head = await this.#repository.reconcile(project);
		project.status = "ready";
		delete project.error;
		this.#publish({ kind: "repository", projectId, text: `Integration reconciled and published: ${project.head}` });
		this.schedule();
	}

	connectRunner(memberId: string, send: RunnerConnection["send"], close: () => void): () => void {
		const previous = this.#runners.get(memberId);
		if (previous) {
			this.#disconnect(memberId, previous);
			previous.close();
		}
		const connection = { send, close, lastHeartbeat: Date.now() };
		this.#runners.set(memberId, connection);
		this.#member(memberId).online = true;
		this.#topology();
		this.#publish({ kind: "room", memberId, text: `${this.#member(memberId).name}'s runner connected` });
		this.schedule();
		return () => this.#disconnect(memberId, connection);
	}
	#disconnect(memberId: string, connection: RunnerConnection): void {
		if (this.#runners.get(memberId) !== connection) return;
		this.#runners.delete(memberId);
		this.#member(memberId).online = false;
		for (const [taskId, lease] of this.#leases) {
			if (lease.connection !== connection) continue;
			const task = this.#task(taskId);
			task.status = "interrupted";
			task.error =
				"Runner disconnected. Review preserved work before retrying; the task was not reassigned automatically.";
			task.updatedAt = Date.now();
			this.#leases.delete(taskId);
		}
		this.#topology();
		this.#publish({ kind: "room", memberId, text: `${this.#member(memberId).name}'s runner disconnected` });
		this.schedule();
	}
	heartbeat(memberId: string): void {
		const runner = this.#runners.get(memberId);
		if (runner) runner.lastHeartbeat = Date.now();
	}
	expire(now = Date.now()): void {
		for (const [id, connection] of this.#runners) {
			if (now - connection.lastHeartbeat > 45_000) {
				this.#disconnect(id, connection);
				connection.close();
			}
		}
	}
	#task(id: string): SwarmTask {
		const task = this.#state.tasks.find(item => item.id === id);
		if (!task) throw new Error("Task does not exist");
		return task;
	}
	#createTask(input: TaskInput, kind: "task" | "question" = "task"): SwarmTask {
		if (
			typeof input.title !== "string" ||
			!input.title.trim() ||
			input.title.length > 300 ||
			typeof input.instructions !== "string" ||
			!input.instructions.trim() ||
			input.instructions.length > 50000
		)
			throw new Error("Provide a task title and instructions");
		if (!this.#state.projects.some(project => project.id === input.projectId))
			throw new Error("Project does not exist");
		if (!this.#state.agents.some(agent => agent.id === input.agentId))
			throw new Error("Agent is disabled or does not exist");
		if (input.paths && (!Array.isArray(input.paths) || input.paths.some(item => typeof item !== "string")))
			throw new Error("paths must be an array of relative paths");
		if (
			input.dependsOn &&
			(!Array.isArray(input.dependsOn) || input.dependsOn.some(item => typeof item !== "string"))
		)
			throw new Error("dependsOn must be an array of task IDs");
		for (const dependency of input.dependsOn ?? [])
			if (this.#task(dependency).projectId !== input.projectId)
				throw new Error("Dependencies must belong to the same project");
		const task: SwarmTask = {
			projectId: input.projectId,
			agentId: input.agentId,
			parentTaskId: input.parentTaskId,
			title: input.title,
			instructions: input.instructions,
			kind,
			id: swarmId(),
			paths: normalizePaths(input.paths ?? []),
			dependsOn: [...new Set(input.dependsOn ?? [])],
			status: "queued",
			attempt: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.#state.tasks.push(task);
		this.#publish({
			kind: "task",
			taskId: task.id,
			projectId: task.projectId,
			agentId: task.agentId,
			text: `Queued: ${task.title}`,
		});
		this.schedule();
		return structuredClone(task);
	}
	createTask(memberId: string, input: TaskInput): SwarmTask {
		this.#member(memberId);
		const agent = this.#state.agents.find(item => item.id === input.agentId);
		if (memberId !== this.#state.hostId && agent?.ownerId !== memberId && agent?.role !== "king")
			throw new Error("Members can submit goals to the king or tasks to their own agents");
		return this.#createTask({ ...input, parentTaskId: undefined });
	}
	#checkLease(memberId: string, taskId: string, token: string): SwarmTask {
		const lease = this.#leases.get(taskId);
		if (!lease || lease.memberId !== memberId || lease.token !== token || this.#task(taskId).status !== "running")
			throw new Error("Task lease expired or belongs to another runner");
		return this.#task(taskId);
	}
	agentAction(
		memberId: string,
		taskId: string,
		lease: string,
		action: string,
		input: Record<string, unknown>,
	): unknown {
		const task = this.#checkLease(memberId, taskId, lease);
		const actor = this.#state.agents.find(agent => agent.id === task.agentId)!;
		if (action === "status") return this.state;
		if (action === "answer") {
			if (
				typeof input.questionTaskId !== "string" ||
				typeof input.text !== "string" ||
				!input.text.trim() ||
				input.text.length > 50000
			)
				throw new Error("Provide questionTaskId and answer text");
			const question = this.#task(input.questionTaskId);
			if (question.kind !== "question" || question.agentId !== actor.id || question.status !== "queued")
				throw new Error("You may answer only a queued question addressed to your agent");
			question.status = "completed";
			question.result = input.text;
			question.updatedAt = Date.now();
			this.#publish({
				kind: "task",
				taskId: question.id,
				agentId: actor.id,
				projectId: question.projectId,
				text: `Answered: ${question.title}`,
				data: { answer: input.text },
			});
			this.schedule();
			return structuredClone(question);
		}
		if (action === "ask") {
			const target = this.#state.agents.find(agent => agent.id === input.agentId);
			if (!target || !isPlanner(target.role) || target.id === actor.id)
				throw new Error("Ask another queen or the king by its agent ID");
			const question = this.#createTask(
				{
					projectId: task.projectId,
					agentId: target.id,
					title: String(input.title ?? `Question from ${actor.name}`),
					instructions: String(input.instructions ?? ""),
					parentTaskId: task.id,
					paths: task.paths,
				},
				"question",
			);
			this.#publish({
				kind: "message",
				memberId,
				agentId: actor.id,
				to: target.id,
				projectId: task.projectId,
				taskId: question.id,
				text: question.instructions,
				data: { questionTaskId: question.id },
			});
			return question;
		}
		if (action === "delegate") {
			const target = this.#state.agents.find(agent => agent.id === input.agentId);
			if (
				!target ||
				target.id === actor.id ||
				(actor.role !== "king" && !(actor.role === "queen" && target.parentId === actor.id))
			)
				throw new Error("Only the king or an agent's assigned queen can delegate to it");
			const child = input as unknown as TaskInput;
			const paths = normalizePaths(child.paths ?? []);
			if (task.paths.length && (!paths.length || paths.some(file => !pathInScope(file, task.paths))))
				throw new Error("A delegated task must stay within its parent's assigned scope");
			return this.#createTask({ ...child, projectId: task.projectId, parentTaskId: task.id, paths });
		}
		if (action === "message") {
			if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 10000)
				throw new Error("Provide a message of 1–10000 characters");
			if (input.to !== undefined && !this.#state.agents.some(agent => agent.id === input.to))
				throw new Error("Recipient does not exist");
			return this.#publish({
				kind: "message",
				memberId,
				agentId: actor.id,
				taskId,
				projectId: task.projectId,
				text: input.text,
				to: input.to as string | undefined,
			});
		}
		throw new Error("Unknown swarm action");
	}
	message(memberId: string, text: string, to?: string): void {
		this.#member(memberId);
		if (typeof text !== "string" || !text.trim() || text.length > 10000)
			throw new Error("Provide a message of 1–10000 characters");
		if (to && !this.#state.agents.some(agent => agent.id === to)) throw new Error("Recipient does not exist");
		this.#publish({ kind: "message", memberId, text, to });
	}
	activity(memberId: string, taskId: string, lease: string, data: unknown): void {
		const task = this.#checkLease(memberId, taskId, lease);
		this.#publish(
			{ kind: "agent_event", memberId, taskId, agentId: task.agentId, projectId: task.projectId, data },
			false,
		);
	}
	schedule(): void {
		if (this.#closing) return;
		let settled: boolean;
		do {
			settled = false;
			for (const parent of this.#state.tasks.filter(task => task.status === "waiting")) {
				const children = this.#state.tasks.filter(task => task.parentTaskId === parent.id);
				if (children.some(task => ["queued", "running", "waiting", "integrating"].includes(task.status))) continue;
				parent.status = children.every(task => task.status === "completed") ? "completed" : "failed";
				if (parent.status === "failed")
					parent.error = "A delegated task did not complete. Review its result and retry as needed.";
				parent.updatedAt = Date.now();
				this.#publish({
					kind: "task",
					taskId: parent.id,
					projectId: parent.projectId,
					text: `${parent.status}: ${parent.title}`,
				});
				settled = true;
			}
		} while (settled);
		for (const task of this.#state.tasks) {
			if (task.status !== "queued") continue;
			const failedDependency = task.dependsOn.find(id =>
				["failed", "interrupted", "conflict", "cancelled"].includes(this.#task(id).status),
			);
			if (failedDependency) {
				task.status = "interrupted";
				task.error = `Dependency ${failedDependency} did not complete. Resolve it, then retry this task.`;
				this.#publish({ kind: "task", taskId: task.id, projectId: task.projectId, text: task.error });
				continue;
			}
			const agent = this.#state.agents.find(item => item.id === task.agentId);
			if (!agent) {
				task.status = "interrupted";
				task.error = "Assigned role was disabled. Enable it again before retrying this task.";
				this.#publish({ kind: "task", taskId: task.id, text: task.error });
				continue;
			}
			if (!agent?.online) continue;
			const connection = this.#runners.get(agent.ownerId);
			if (!connection) continue;
			if (task.dependsOn.some(id => this.#task(id).status !== "completed")) continue;
			const project = this.#state.projects.find(item => item.id === task.projectId)!;
			if (project.status !== "ready") continue;
			const active = this.#state.tasks.filter(item => item.status === "running" || item.status === "integrating");
			if (active.some(item => item.agentId === agent.id)) continue;
			if (
				!isPlanner(agent.role) &&
				active.some(
					item =>
						item.projectId === task.projectId &&
						!isPlanner(this.#state.agents.find(other => other.id === item.agentId)!.role) &&
						pathsOverlap(task.paths, item.paths),
				)
			)
				continue;
			task.status = "running";
			task.attempt++;
			task.base = project.head;
			task.branch = `agentcord/${project.id}/tasks/${task.id}-${task.attempt}`;
			task.updatedAt = Date.now();
			delete task.error;
			const lease = crypto.randomUUID();
			this.#leases.set(task.id, { token: lease, memberId: agent.ownerId, connection });
			this.#publish({
				kind: "task",
				taskId: task.id,
				agentId: agent.id,
				projectId: project.id,
				text: `Started: ${task.title} (attempt ${task.attempt}, base ${task.base})`,
			});
			try {
				connection.send({
					task: structuredClone(task),
					agent: structuredClone(agent),
					project: structuredClone(project),
					lease,
					instructions: this.#member(agent.ownerId).settings[agent.role].instructions,
				});
			} catch {
				this.#disconnect(agent.ownerId, connection);
			}
		}
	}
	async finish(
		memberId: string,
		taskId: string,
		lease: string,
		result: { commit?: string; result?: string; error?: string },
	): Promise<void> {
		const task = this.#checkLease(memberId, taskId, lease);
		const agent = this.#state.agents.find(item => item.id === task.agentId)!;
		this.#leases.delete(taskId);
		task.result = result.result?.slice(0, 100000);
		task.updatedAt = Date.now();
		if (result.error) {
			task.status = "failed";
			task.error = result.error;
		} else if (isPlanner(agent.role))
			task.status = this.#state.tasks.some(child => child.parentTaskId === task.id) ? "waiting" : "completed";
		else if (!result.commit || !/^[a-f0-9]{40,64}$/.test(result.commit)) {
			task.status = "failed";
			task.error = "Runner did not return a published Git commit";
		} else {
			task.commit = result.commit;
			task.status = "integrating";
			this.#publish({ kind: "task", taskId, projectId: task.projectId, text: `Integrating: ${task.title}` });
			const integrate = async () => {
				const project = this.#state.projects.find(item => item.id === task.projectId)!;
				try {
					project.head = await this.#repository.integrate(project, task, result.commit!);
					task.status = "completed";
					this.#publish({
						kind: "repository",
						projectId: project.id,
						taskId,
						text: `Integrated ${task.title}: ${project.head}`,
					});
				} catch (error) {
					task.status = "conflict";
					task.error = errorText(error);
					// Do not dispatch new work against a potentially unpublished integration revision.
					project.status = "error";
					project.error = task.error;
				}
			};
			this.#integrations = this.#integrations.then(integrate);
			await this.#integrations;
		}
		task.updatedAt = Date.now();
		this.#publish({
			kind: "task",
			taskId,
			projectId: task.projectId,
			agentId: task.agentId,
			text: `${task.status}: ${task.title}${task.error ? ` — ${task.error}` : ""}`,
		});
		this.schedule();
	}
	taskAction(memberId: string, taskId: string, action: "retry" | "cancel"): void {
		const task = this.#task(taskId);
		const owner = this.#state.agents.find(agent => agent.id === task.agentId)?.ownerId;
		if (memberId !== this.#state.hostId && memberId !== owner)
			throw new Error("Only the host or assigned member may change this task");
		if (["running", "waiting", "integrating", "completed"].includes(task.status))
			throw new Error("Running, waiting, integrating, and completed tasks cannot be retried or cancelled");
		task.status = action === "retry" ? "queued" : "cancelled";
		task.updatedAt = Date.now();
		this.#publish({ kind: "task", taskId, text: `${action}: ${task.title}` });
		this.schedule();
	}
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#publish(event: Omit<Activity, "seq" | "time">, stateChanged = true): Activity {
		const entry = stateChanged ? this.store.commit(this.#state, event) : this.store.append(event);
		for (const listener of this.#listeners) listener(this.#state, entry);
		return entry;
	}
	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		for (const [id, connection] of this.#runners) {
			this.#disconnect(id, connection);
			connection.close();
		}
		await this.#integrations;
		this.store.close();
	}
}
