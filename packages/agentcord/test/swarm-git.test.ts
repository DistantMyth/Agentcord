import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { GitProjectRepository, GitTaskWorkspaces } from "../src/swarm/repository";
import { swarmId } from "../src/swarm/types";
import type { SwarmTask } from "../src/swarm/types";
import { SwarmHub } from "../src/swarm/hub";
import { SwarmRunner } from "../src/swarm/runner";
import type { TaskRuntime } from "../src/swarm/runner";
import { SwarmServer } from "../src/swarm/server";
import { SwarmStore } from "../src/swarm/store";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "agentcord-git-")))
			throw new Error("Invalid temporary fixture directory");
		await fs.rm(directory, { recursive: true, force: true });
	}
});

/** Minimal on-disk Git fixture; real native VCS operations handle all commits and transport. */
async function initializeFixture(directory: string, bare: boolean): Promise<void> {
	const metadata = bare ? directory : path.join(directory, ".git");
	await fs.mkdir(path.join(metadata, "objects"), { recursive: true });
	await fs.mkdir(path.join(metadata, "objects", "info"), { recursive: true });
	await fs.mkdir(path.join(metadata, "objects", "pack"), { recursive: true });
	await fs.mkdir(path.join(metadata, "refs", "heads"), { recursive: true });
	await Bun.write(path.join(metadata, "HEAD"), "ref: refs/heads/main\n");
	await Bun.write(path.join(metadata, "config"), `[core]\nrepositoryformatversion = 0\nbare = ${bare}\n`);
}
async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentcord-git-"));
	directories.push(directory);
	const source = path.join(directory, "source"),
		remote = path.join(directory, "remote.git");
	await initializeFixture(source, false);
	await initializeFixture(remote, true);
	await Bun.write(path.join(source, "src", "shared.txt"), "original\n");
	await Bun.write(path.join(source, "README.md"), "Project\n");
	const repo = vcs.requireGit(source);
	await repo.stageFiles(["."]);
	const base = await repo.commitCreate("Initial fixture", { author: { name: "Test", email: "test@localhost" } });
	await repo.remoteAdd("origin", remote);
	await repo.push({ remote: "origin", refspec: "refs/heads/main:refs/heads/main" });
	const projects = new GitProjectRepository(path.join(directory, "projects"));
	const project = await projects.attach(source, swarmId(), "Fixture", "HEAD", "origin");
	const workspaces = new GitTaskWorkspaces(path.join(directory, "runner"));
	return { directory, source, repo, base, project, projects, workspaces };
}
function task(projectId: string, base: string, paths: string[]): SwarmTask {
	const id = swarmId();
	return {
		id,
		kind: "task",
		projectId,
		agentId: "worker",
		title: "Fixture change",
		instructions: "Implement change",
		paths,
		dependsOn: [],
		status: "running",
		attempt: 1,
		base,
		branch: `agentcord/${projectId}/tasks/${id}-1`,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

test("real task worktrees publish and integrate disjoint changes without changing the source checkout", async () => {
	const f = await fixture();
	const first = task(f.project.id, f.base, ["src/auth"]),
		second = task(f.project.id, f.base, ["src/search"]);
	const firstWorkspace = await f.workspaces.prepare(f.project, first),
		secondWorkspace = await f.workspaces.prepare(f.project, second);
	await Bun.write(path.join(firstWorkspace.directory, "src/auth/index.ts"), "export const auth = true;\n");
	await Bun.write(path.join(secondWorkspace.directory, "src/search/index.ts"), "export const search = true;\n");
	const firstCommit = await firstWorkspace.finish(),
		secondCommit = await secondWorkspace.finish();
	first.commit = firstCommit;
	second.commit = secondCommit;
	f.project.head = await f.projects.integrate(f.project, first, firstCommit);
	f.project.head = await f.projects.integrate(f.project, second, secondCommit);
	const integration = vcs.requireGit(path.join(f.directory, "projects", f.project.id, "integration"));
	expect((await integration.showBlob("HEAD:src/auth/index.ts")).data.toString()).toContain("auth = true");
	expect((await integration.showBlob("HEAD:src/search/index.ts")).data.toString()).toContain("search = true");
	expect(await integration.isDirty()).toBe(false);
	expect(await f.repo.headSha()).toBe(f.base);
	expect(await f.repo.currentBranch()).toBe("main");
	expect(await f.repo.isDirty()).toBe(false);
}, 30000);

test("scope violations and conflicting branches are rejected with the original work preserved", async () => {
	const f = await fixture(),
		scoped = task(f.project.id, f.base, ["src"]);
	const workspace = await f.workspaces.prepare(f.project, scoped);
	await Bun.write(path.join(workspace.directory, "README.md"), "Out of scope\n");
	await expect(workspace.finish()).rejects.toThrow("outside the assigned scope");
	expect(await Bun.file(path.join(workspace.directory, "README.md")).text()).toBe("Out of scope\n");
	const one = task(f.project.id, f.base, ["src/shared.txt"]),
		two = task(f.project.id, f.base, ["src/shared.txt"]);
	const left = await f.workspaces.prepare(f.project, one),
		right = await f.workspaces.prepare(f.project, two);
	await Bun.write(path.join(left.directory, "src/shared.txt"), "first replacement\n");
	await Bun.write(path.join(right.directory, "src/shared.txt"), "second replacement\n");
	const leftCommit = await left.finish(),
		rightCommit = await right.finish();
	f.project.head = await f.projects.integrate(f.project, one, leftCommit);
	await expect(f.projects.integrate(f.project, two, rightCommit)).rejects.toThrow("conflicts");
	expect(await Bun.file(path.join(right.directory, "src/shared.txt")).text()).toBe("second replacement\n");
	const integration = vcs.requireGit(path.join(f.directory, "projects", f.project.id, "integration"));
	expect(await integration.isDirty()).toBe(false);
	expect(await integration.headSha()).toBe(f.project.head);
}, 30000);

test("two members dispatch over WebSockets and publish their isolated work into one integration branch", async () => {
	const f = await fixture();
	const hub = new SwarmHub(new SwarmStore(":memory:"), f.projects, "Alice");
	await hub.attachProject(hub.state.hostId, f.source, "Shared project", "HEAD");
	const bob = hub.join("Bob", hub.inviteToken),
		server = new SwarmServer(hub, { port: 0 });
	const url = server.start(),
		errors: string[] = [],
		observed: string[] = [];
	const runtime: TaskRuntime = {
		run: async (assignment, workspace, _action, emit) => {
			const file = `${assignment.task.paths[0]}/result.txt`;
			await Bun.write(path.join(workspace.directory, file), assignment.agent.ownerId);
			emit({ type: "tool_execution_end", toolName: "fixture-write", result: { file } });
			return `Wrote ${file}`;
		},
	};
	const aliceRunner = new SwarmRunner({
		url,
		token: hub.hostToken,
		directory: path.join(f.directory, "alice"),
		runtime,
		onError: message => errors.push(message),
		onState: state => observed.push(...state.tasks.map(task => task.status)),
	});
	const bobRunner = new SwarmRunner({
		url,
		token: bob.token,
		directory: path.join(f.directory, "bob"),
		runtime,
		onError: message => errors.push(message),
	});
	try {
		await aliceRunner.start();
		await bobRunner.start();
		const project = hub.state.projects[0]!;
		for (const [memberId, scope] of [
			[hub.state.hostId, "src/auth"],
			[bob.member.id, "src/search"],
		]) {
			const worker = hub.state.agents.find(agent => agent.ownerId === memberId && agent.role === "worker")!;
			hub.createTask(hub.state.hostId, {
				projectId: project.id,
				agentId: worker.id,
				title: `Write ${scope}`,
				instructions: "Fixture write",
				paths: [scope!],
			});
		}
		const deadline = Date.now() + 25000;
		while (
			hub.state.tasks.some(task => ["queued", "running", "integrating"].includes(task.status)) &&
			Date.now() < deadline
		)
			await Bun.sleep(25);
		expect(errors).toEqual([]);
		expect(hub.state.tasks.map(task => ({ status: task.status, error: task.error }))).toEqual([
			{ status: "completed", error: undefined },
			{ status: "completed", error: undefined },
		]);
		expect(observed).toContain("running");
		const integration = vcs.requireGit(path.join(f.directory, "projects", project.id, "integration"));
		expect((await integration.showBlob("HEAD:src/auth/result.txt")).data.toString()).toBe(hub.state.hostId);
		expect((await integration.showBlob("HEAD:src/search/result.txt")).data.toString()).toBe(bob.member.id);
		expect(hub.store.events().filter(event => event.kind === "agent_event").length).toBe(2);
	} finally {
		await aliceRunner.stop();
		await bobRunner.stop();
		await server.stop();
	}
}, 40000);
