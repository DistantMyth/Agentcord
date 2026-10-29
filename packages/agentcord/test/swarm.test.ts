import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SwarmHub } from "../src/swarm/hub";
import type { ProjectRepository } from "../src/swarm/repository";
import { SwarmStore } from "../src/swarm/store";
import { defaultSettings } from "../src/swarm/types";
import type { Assignment, Project, Role, SwarmTask } from "../src/swarm/types";

class TestRepository implements ProjectRepository {
	async attach(_directory: string, id: string, name: string, baseRef: string): Promise<Project> {
		return {
			id,
			name,
			baseRef,
			repositoryUrl: "test-remote",
			integrationBranch: `agentcord/${id}/integration`,
			head: "a".repeat(40),
			status: "ready",
		};
	}
	async integrate(_project: Project, _task: SwarmTask, commit: string): Promise<string> {
		return commit;
	}
}
const hubs: SwarmHub[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const hub of hubs.splice(0)) await hub.close();
	for (const directory of directories.splice(0)) {
		if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "agentcord-test-")))
			throw new Error("Invalid temporary test directory");
		await fs.rm(directory, { recursive: true, force: true });
	}
});
async function setup(file = ":memory:") {
	const hub = new SwarmHub(new SwarmStore(file), new TestRepository(), "Alice");
	hubs.push(hub);
	await hub.attachProject(hub.state.hostId, ".", "Project", "HEAD");
	return hub;
}
function connect(hub: SwarmHub, id: string) {
	const assignments: Assignment[] = [];
	const disconnect = hub.connectRunner(
		id,
		assignment => assignments.push(assignment),
		() => {},
	);
	return { assignments, disconnect };
}
function agents(hub: SwarmHub, memberId: string, role: Role) {
	return hub.state.agents.filter(agent => agent.ownerId === memberId && agent.role === role);
}
function enqueue(hub: SwarmHub, agentId: string, paths: string[], dependsOn: string[] = []) {
	return hub.createTask(hub.state.hostId, {
		projectId: hub.state.projects[0]!.id,
		agentId,
		title: `Implement ${paths}`,
		instructions: "Implement the assigned change",
		paths,
		dependsOn,
	});
}

describe("shared swarm ownership and scheduling", () => {
	test("coordinators remain waiting for delegated work and fail if a child fails", async () => {
		const hub = await setup(),
			runner = connect(hub, hub.state.hostId);
		const queen = agents(hub, hub.state.hostId, "queen")[0]!,
			worker = agents(hub, hub.state.hostId, "worker")[0]!;
		const parent = enqueue(hub, queen.id, []),
			parentLease = runner.assignments[0]!.lease;
		const child = hub.agentAction(hub.state.hostId, parent.id, parentLease, "delegate", {
			agentId: worker.id,
			title: "Implement",
			instructions: "Implement change",
			paths: ["src"],
		}) as SwarmTask;
		await hub.finish(hub.state.hostId, parent.id, parentLease, { result: "Delegated implementation" });
		expect(hub.state.tasks.find(task => task.id === parent.id)?.status).toBe("waiting");
		await hub.finish(hub.state.hostId, child.id, runner.assignments.find(item => item.task.id === child.id)!.lease, {
			error: "Compilation failed",
		});
		expect(hub.state.tasks.find(task => task.id === parent.id)?.status).toBe("failed");
	});
	test("disabled queens share their workers between available queens without transferring ownership", async () => {
		const hub = await setup();
		connect(hub, hub.state.hostId);
		const bob = hub.join("Bob", hub.inviteToken).member,
			carol = hub.join("Carol", hub.inviteToken).member;
		connect(hub, bob.id);
		connect(hub, carol.id);
		const settings = defaultSettings();
		settings.queen.enabled = false;
		settings.testgen.enabled = false;
		settings.tester.enabled = false;
		settings.worker.count = 4;
		hub.updateSettings(bob.id, settings);
		const workers = agents(hub, bob.id, "worker");
		expect(new Set(workers.map(worker => worker.parentId)).size).toBe(2);
		expect(workers.every(worker => worker.ownerId === bob.id)).toBe(true);
		for (const id of [hub.state.hostId, carol.id]) {
			const own = hub.state.members.find(member => member.id === id)!;
			const next = structuredClone(own.settings);
			next.queen.enabled = false;
			hub.updateSettings(id, next);
		}
		expect(
			agents(hub, bob.id, "worker").every(
				worker => worker.parentId === agents(hub, hub.state.hostId, "king")[0]!.id,
			),
		).toBe(true);
		for (const role of ["queen", "worker", "testgen", "tester"] as const) settings[role].enabled = false;
		hub.updateSettings(bob.id, settings);
		expect(hub.state.agents.some(agent => agent.ownerId === bob.id)).toBe(false);
		settings.king.enabled = true;
		expect(() => hub.updateSettings(bob.id, settings)).toThrow("single king");
	});

	test("overlapping files queue while disjoint work runs, and dependencies receive the integrated revision", async () => {
		const hub = await setup();
		const config = defaultSettings(true);
		config.worker.count = 3;
		hub.updateSettings(hub.state.hostId, config);
		const runner = connect(hub, hub.state.hostId),
			workers = agents(hub, hub.state.hostId, "worker");
		const first = enqueue(hub, workers[0]!.id, ["src/auth"]);
		const second = enqueue(hub, workers[1]!.id, ["src/auth/login.ts"]);
		const dependent = enqueue(hub, agents(hub, hub.state.hostId, "tester")[0]!.id, ["tests"], [first.id]);
		const third = enqueue(hub, workers[2]!.id, ["docs"]);
		expect(runner.assignments.map(item => item.task.id)).toEqual([first.id, third.id]);
		await hub.finish(hub.state.hostId, first.id, runner.assignments[0]!.lease, {
			commit: "b".repeat(40),
			result: "Implemented",
		});
		const next = runner.assignments.find(item => item.task.id === second.id)!;
		expect(next.task.base).toBe("b".repeat(40));
		expect(runner.assignments.find(item => item.task.id === dependent.id)?.task.base).toBe("b".repeat(40));
		expect(hub.state.tasks.find(item => item.id === first.id)?.status).toBe("completed");
	});

	test("disconnects interrupt work without automatic duplication and old leases cannot publish after retry", async () => {
		const hub = await setup(),
			runner = connect(hub, hub.state.hostId);
		const task = enqueue(hub, agents(hub, hub.state.hostId, "worker")[0]!.id, ["src"]),
			previous = runner.assignments[0]!;
		runner.disconnect();
		expect(hub.state.tasks[0]!.status).toBe("interrupted");
		const nextRunner = connect(hub, hub.state.hostId);
		expect(nextRunner.assignments).toEqual([]);
		hub.taskAction(hub.state.hostId, task.id, "retry");
		expect(nextRunner.assignments[0]!.task.attempt).toBe(2);
		expect(nextRunner.assignments[0]!.task.branch).not.toBe(previous.task.branch);
		await expect(hub.finish(hub.state.hostId, task.id, previous.lease, { commit: "b".repeat(40) })).rejects.toThrow(
			"lease expired",
		);
		await hub.finish(hub.state.hostId, task.id, nextRunner.assignments[0]!.lease, { commit: "b".repeat(40) });
		expect(hub.state.tasks[0]!.status).toBe("completed");
	});

	test("a queen controls adopted cross-user helpers but cannot delegate outside her scope", async () => {
		const hub = await setup(),
			host = connect(hub, hub.state.hostId);
		const bob = hub.join("Bob", hub.inviteToken).member;
		const settings = defaultSettings();
		settings.queen.enabled = false;
		hub.updateSettings(bob.id, settings);
		connect(hub, bob.id);
		const queen = agents(hub, hub.state.hostId, "queen")[0]!,
			worker = agents(hub, bob.id, "worker")[0]!;
		const parent = enqueue(hub, queen.id, ["src"]),
			assignment = host.assignments.find(item => item.task.id === parent.id)!;
		expect(() =>
			hub.agentAction(hub.state.hostId, parent.id, assignment.lease, "delegate", {
				agentId: worker.id,
				title: "Outside",
				instructions: "Outside scope",
				paths: ["docs"],
			}),
		).toThrow("scope");
		const child = hub.agentAction(hub.state.hostId, parent.id, assignment.lease, "delegate", {
			agentId: worker.id,
			title: "Auth",
			instructions: "Implement auth",
			paths: ["src/auth"],
		}) as SwarmTask;
		expect(child.parentTaskId).toBe(parent.id);
		expect(child.status).toBe("running");
		expect(() => hub.agentAction(bob.id, parent.id, assignment.lease, "status", {})).toThrow("another runner");
	});

	test("busy kings can answer worker questions while their root task waits for those workers", async () => {
		const hub = await setup(),
			runner = connect(hub, hub.state.hostId);
		const king = agents(hub, hub.state.hostId, "king")[0]!,
			worker = agents(hub, hub.state.hostId, "worker")[0]!;
		const root = enqueue(hub, king.id, []),
			child = enqueue(hub, worker.id, ["src"]);
		const kingAssignment = runner.assignments.find(item => item.task.id === root.id)!,
			workerAssignment = runner.assignments.find(item => item.task.id === child.id)!;
		const question = hub.agentAction(hub.state.hostId, child.id, workerAssignment.lease, "ask", {
			agentId: king.id,
			instructions: "Which API contract?",
		}) as SwarmTask;
		expect(question.status).toBe("queued");
		hub.agentAction(hub.state.hostId, root.id, kingAssignment.lease, "answer", {
			questionTaskId: question.id,
			text: "Use the documented v2 API",
		});
		expect(hub.state.tasks.find(task => task.id === question.id)?.result).toContain("v2 API");
		expect(hub.state.tasks.find(task => task.id === root.id)?.status).toBe("running");
	});

	test("failed dependencies interrupt downstream testing instead of leaving a misleading running queue", async () => {
		const hub = await setup(),
			runner = connect(hub, hub.state.hostId);
		const first = enqueue(hub, agents(hub, hub.state.hostId, "worker")[0]!.id, []);
		const tester = enqueue(hub, agents(hub, hub.state.hostId, "tester")[0]!.id, [], [first.id]);
		await hub.finish(hub.state.hostId, first.id, runner.assignments[0]!.lease, {
			error: "Provider authentication failed",
		});
		expect(hub.state.tasks.find(task => task.id === tester.id)?.status).toBe("interrupted");
		expect(runner.assignments.length).toBe(1);
	});

	test("restart preserves identities, settings and event ordering, and interrupts unconfirmed work", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentcord-test-"));
		directories.push(directory);
		const file = path.join(directory, "hub.sqlite"),
			hub = await setup(file),
			runner = connect(hub, hub.state.hostId);
		const bob = hub.join("Bob", hub.inviteToken),
			settings = defaultSettings();
		settings.queen.enabled = false;
		settings.worker.model = "custom/model";
		hub.updateSettings(bob.member.id, settings);
		const task = enqueue(hub, agents(hub, hub.state.hostId, "worker")[0]!.id, []),
			stableId = runner.assignments[0]!.agent.id;
		hub.message(bob.member.id, "Persist this message");
		await hub.close();
		hubs.splice(hubs.indexOf(hub), 1);
		const restarted = new SwarmHub(new SwarmStore(file), new TestRepository(), "Ignored new name");
		hubs.push(restarted);
		expect(restarted.authenticate(bob.token)).toBe(bob.member.id);
		expect(restarted.state.members.find(member => member.id === bob.member.id)?.settings.worker.model).toBe(
			"custom/model",
		);
		expect(restarted.state.agents.some(agent => agent.id === stableId)).toBe(true);
		expect(restarted.state.tasks.find(item => item.id === task.id)?.status).toBe("interrupted");
		const entries = restarted.store.events();
		const last = entries.at(-1)!;
		restarted.message(bob.member.id, "After restart");
		expect(restarted.store.events(last.seq).map(entry => entry.text)).toEqual(["After restart"]);
		expect(entries.some(entry => entry.text === "Persist this message")).toBe(true);
	});
});
