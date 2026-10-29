import * as path from "node:path";
import * as fs from "node:fs/promises";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { SwarmHub } from "./hub";
import { GitProjectRepository } from "./repository";
import { SwarmRunner } from "./runner";
import { SwarmServer } from "./server";
import { SwarmStore } from "./store";

export interface HostOptions {
	name: string;
	directory: string;
	port?: number;
	hostname?: string;
	repository?: string;
	base?: string;
	remote?: string;
	command?: string[];
	onError?: (message: string) => void;
}

export interface HostedSwarm {
	hub: SwarmHub;
	server: SwarmServer;
	runner: SwarmRunner;
	url: string;
	guiUrl: string;
	stop(): Promise<void>;
}

export async function hostSwarm(options: HostOptions): Promise<HostedSwarm> {
	const directory = path.resolve(options.directory);
	await fs.mkdir(directory, { recursive: true });
	const lock = tryAcquireFileLock(path.join(directory, "hub.sqlite"));
	if (!lock)
		throw new Error("A hub already owns this data directory. Connect to that hub instead of starting a second king.");
	let hub: SwarmHub;
	try {
		hub = new SwarmHub(
			new SwarmStore(path.join(directory, "hub.sqlite")),
			new GitProjectRepository(path.join(directory, "projects")),
			options.name,
		);
	} catch (error) {
		lock.release();
		throw error;
	}
	try {
		if (options.repository && !hub.state.projects.length) {
			await hub.attachProject(
				hub.state.hostId,
				path.resolve(options.repository),
				path.basename(path.resolve(options.repository)),
				options.base ?? "HEAD",
				options.remote ?? "origin",
			);
		}
		const server = new SwarmServer(hub, { port: options.port ?? 7466, hostname: options.hostname });
		const url = server.start();
		const runner = new SwarmRunner({
			url,
			token: hub.hostToken,
			directory: path.join(directory, "r"),
			command: options.command,
			onError: options.onError,
		});
		try {
			await runner.start();
		} catch (error) {
			await server.stop();
			throw error;
		}
		return {
			hub,
			server,
			runner,
			url,
			guiUrl: `${url}/#token=${hub.hostToken}`,
			stop: async () => {
				try {
					await runner.stop();
					await server.stop();
				} finally {
					lock.release();
				}
			},
		};
	} catch (error) {
		await hub.close();
		lock.release();
		throw error;
	}
}

export interface MemberCredential {
	url: string;
	token: string;
	name: string;
}

export async function joinSwarm(
	urlOrInvite: string,
	name: string,
	directory: string,
	token?: string,
): Promise<MemberCredential> {
	const link = new URL(urlOrInvite);
	if (!["http:", "https:"].includes(link.protocol)) throw new Error("Use an HTTP(S) room URL or invite link");
	const url = link.origin;
	const infoResponse = await fetch(new URL("/api/info", url));
	if (!infoResponse.ok) throw new Error("Cannot read room information");
	const info = (await infoResponse.json()) as { roomId: string };
	const credentialFile = path.join(
		directory,
		`member-${new Bun.CryptoHasher("sha256").update(`${url}/${info.roomId}/${name}`).digest("hex").slice(0, 16)}.json`,
	);
	const memberToken = token ?? new URLSearchParams(link.hash.slice(1)).get("token");
	if (memberToken) return { url, token: memberToken, name };
	try {
		const saved = (await Bun.file(credentialFile).json()) as MemberCredential;
		if (saved.url === url) return saved;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const invite = new URLSearchParams(link.hash.slice(1)).get("invite");
	if (!invite) throw new Error("Use a full invite link, or provide your existing member token with --token");
	const response = await fetch(new URL("/api/join", url), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, invite }),
	});
	const result = (await response.json()) as { token?: string; error?: string };
	if (!response.ok || !result.token) throw new Error(result.error ?? "Cannot join room");
	const credential = { url, token: result.token, name };
	await Bun.write(credentialFile, JSON.stringify(credential, null, 2), { mode: 0o600 });
	return credential;
}
