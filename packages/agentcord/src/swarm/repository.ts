import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { Project, SwarmTask } from "./types";
import { pathInScope } from "./types";

export interface ProjectRepository {
	attach(directory: string, id: string, name: string, baseRef: string, remote: string): Promise<Project>;
	integrate(project: Project, task: SwarmTask, commit: string): Promise<string>;
	reconcile?(project: Project): Promise<string>;
}

/** All VCS operations use OMP's bounded, non-interactive native VCS API. */
export class GitProjectRepository implements ProjectRepository {
	#root: string;
	constructor(directory: string) {
		this.#root = path.resolve(directory);
	}
	#integration(id: string): string {
		return path.join(this.#root, id, "integration");
	}

	async attach(directory: string, id: string, name: string, baseRef: string, remote: string): Promise<Project> {
		const source = vcs.requireGit(directory);
		const repositoryUrl = await source.remoteUrl(remote);
		if (!repositoryUrl)
			throw new Error(`Remote ${remote} is not configured. All members need access to a shared Git remote.`);
		let sharedUrl = repositoryUrl;
		if (/^https?:\/\//i.test(sharedUrl)) {
			const parsed = new URL(sharedUrl);
			parsed.username = "";
			parsed.password = "";
			sharedUrl = parsed.href;
		}
		const base = await source.resolveRef(baseRef);
		if (!base) throw new Error(`Cannot resolve project base ${baseRef}`);
		const integrationBranch = `agentcord/${id}/integration`;
		await source.createBranch(integrationBranch, base, false);
		const integration = this.#integration(id);
		await fs.mkdir(path.dirname(integration), { recursive: true });
		await source.worktreeAdd(integration, integrationBranch, { detach: false, clone: false });
		const repo = vcs.requireGit(integration);
		await repo.push({ remote, refspec: `refs/heads/${integrationBranch}:refs/heads/${integrationBranch}` });
		await Bun.write(path.join(this.#root, id, "remote.json"), JSON.stringify({ remote }));
		return { id, name, repositoryUrl: sharedUrl, baseRef, integrationBranch, head: base, status: "ready" };
	}

	async integrate(project: Project, task: SwarmTask, commit: string): Promise<string> {
		if (!task.branch || !task.base) throw new Error("Task has no pinned repository revision");
		const repo = vcs.requireGit(this.#integration(project.id));
		const { remote } = (await Bun.file(path.join(this.#root, project.id, "remote.json")).json()) as {
			remote: string;
		};
		if (await repo.isDirty())
			throw new Error("Integration workspace has uncommitted changes; preserve and resolve them before retrying");
		// A previous push may have failed after local integration. Keep that commit recoverable.
		const current = await repo.headSha();
		if (current !== project.head)
			throw new Error(
				"Integration HEAD differs from the recorded revision. Reconcile the integration branch before retrying.",
			);
		const importedRef = `refs/agentcord/${task.id}/${task.attempt}`;
		await repo.fetch(remote, `refs/heads/${task.branch}`, importedRef);
		if ((await repo.resolveRef(importedRef)) !== commit)
			throw new Error("Published task branch does not match the reported commit");
		if ((await repo.mergeBase(task.base, commit)) !== task.base)
			throw new Error("Task history is not descended from its assigned base");
		const files = await repo.changedFiles({ base: task.base, head: commit });
		if (files.some(file => !pathInScope(file, task.paths)))
			throw new Error("Task changed files outside its assigned scope; branch preserved for review");
		if (commit === task.base) return project.head;
		// Apply the complete diff as one atomic integration commit. No partially applied sequence of commits.
		const patch = await repo.diffTree(task.base, commit, true);
		if (!patch.trim()) return project.head;
		if (!(await repo.canApplyPatch(patch, {})))
			throw new Error("Task conflicts with the integration branch; branch preserved for review");
		await repo.applyPatch(patch, {});
		await repo.stageFiles(["."]);
		const head = await repo.commitCreate(`Agentcord: ${task.title}`, {
			author: { name: "Agentcord", email: "agentcord@localhost" },
		});
		try {
			await repo.push({
				remote,
				refspec: `refs/heads/${project.integrationBranch}:refs/heads/${project.integrationBranch}`,
			});
		} catch (error) {
			throw new Error(
				`Integration commit ${head} was created but could not be published. Resolve the remote before continuing. ${String(error)}`,
			);
		}
		return head;
	}
	async reconcile(project: Project): Promise<string> {
		const repo = vcs.requireGit(this.#integration(project.id));
		if (await repo.isDirty())
			throw new Error(`Resolve the preserved uncommitted changes in ${this.#integration(project.id)} first`);
		if ((await repo.currentBranch()) !== project.integrationBranch)
			throw new Error("Restore the integration branch before resuming");
		const { remote } = (await Bun.file(path.join(this.#root, project.id, "remote.json")).json()) as {
			remote: string;
		};
		await repo.push({
			remote,
			refspec: `refs/heads/${project.integrationBranch}:refs/heads/${project.integrationBranch}`,
		});
		const head = await repo.headSha();
		if (!head) throw new Error("Integration branch has no HEAD");
		return head;
	}
}

export interface TaskWorkspace {
	directory: string;
	finish(): Promise<string>;
}

export class GitTaskWorkspaces {
	#root: string;
	constructor(directory: string) {
		this.#root = path.resolve(directory);
	}
	async prepare(project: Project, task: SwarmTask): Promise<TaskWorkspace> {
		if (!task.base || !task.branch) throw new Error("Task has no repository assignment");
		const clone = path.join(this.#root, project.id, "r");
		try {
			await fs.stat(path.join(clone, ".git"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fs.mkdir(path.dirname(clone), { recursive: true });
			await vcs.clone(project.repositoryUrl, clone, { timeoutMs: 120_000 });
		}
		const repo = vcs.requireGit(clone);
		await repo.fetch(
			"origin",
			`refs/heads/${project.integrationBranch}`,
			`refs/remotes/origin/${project.integrationBranch}`,
		);
		if (!(await repo.resolveRef(task.base)))
			throw new Error("Assigned base is unavailable from the shared integration branch");
		await repo.createBranch(task.branch, task.base, false);
		const directory = path.join(this.#root, project.id, "t", `${task.id}-${task.attempt}`);
		await fs.mkdir(path.dirname(directory), { recursive: true });
		await repo.worktreeAdd(directory, task.branch, { detach: false, clone: false });
		const worktree = vcs.requireGit(directory);
		return {
			directory,
			finish: async () => {
				if ((await worktree.currentBranch()) !== task.branch)
					throw new Error("Agent changed its task branch; workspace preserved for review");
				const dirtyFiles = [
					...(await worktree.changedFiles({ base: task.base })),
					...(await worktree.lsFiles(true, true)),
				];
				if (dirtyFiles.some(file => !pathInScope(file, task.paths)))
					throw new Error("Agent edited files outside the assigned scope; workspace preserved for review");
				if (await worktree.isDirty()) {
					await worktree.stageFiles(["."]);
					await worktree.commitCreate(`Agentcord task: ${task.title}`, {
						author: { name: "Agentcord", email: "agentcord@localhost" },
					});
				}
				const commit = await worktree.headSha();
				if (!commit) throw new Error("Task workspace has no HEAD");
				await worktree.push({ remote: "origin", refspec: `refs/heads/${task.branch}:refs/heads/${task.branch}` });
				return commit;
			},
		};
	}
}
