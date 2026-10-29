#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as path from "node:path";
import { hostSwarm, joinSwarm } from "./swarm/app";
import { SwarmRunner } from "./swarm/runner";
import { errorText } from "./swarm/types";

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			host: { type: "boolean" },
			join: { type: "string" },
			name: { type: "string", default: "Developer" },
			repo: { type: "string" },
			base: { type: "string", default: "HEAD" },
			remote: { type: "string", default: "origin" },
			port: { type: "string", default: "7466" },
			bind: { type: "string", default: "127.0.0.1" },
			data: { type: "string", default: ".agentcord" },
			token: { type: "string" },
			"omp-command": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
	});
	if (values.help || (!values.host && !values.join)) {
		console.log(
			"Agentcord — shared OMP swarm\n\nHost:\n  bun run agentcord --host --name Alice --repo ./project\n  Add --bind 0.0.0.0 for LAN access. Share the invite from the GUI.\n\nJoin (runs your enabled agents using your own OMP credentials):\n  bun run agentcord --join '<full-invite-link>' --name Bob\n  Or copy your runner command from the GUI after joining in a browser.\n\nOptions:\n  --data <directory>    State, credentials, sessions and task workspaces (.agentcord)\n  --base <revision>     Committed revision to start a project from (HEAD)\n  --remote <name>       Shared Git remote (origin); every runner needs push access\n  --port <number>       Hub port (7466)\n  --bind <address>      Hub address (127.0.0.1)\n  --token <token>       Reconnect using your existing member token\n  --omp-command <JSON>  Existing OMP executable argv, e.g. '[\"omp\"]'\n\nModels/providers are configured in OMP; role enablement and model selection live in the GUI.\nNo simulated executions or test results are used.",
		);
		return;
	}
	if (values.host && values.join) throw new Error("Choose either --host or --join");
	const directory = path.resolve(values.data);
	let command: string[] | undefined;
	if (values["omp-command"]) {
		const parsed: unknown = JSON.parse(values["omp-command"]);
		if (!Array.isArray(parsed) || !parsed.length || parsed.some(item => typeof item !== "string"))
			throw new Error("--omp-command must be a JSON array of executable and arguments");
		command = parsed as string[];
	}
	const onError = (message: string) => {
		process.stderr.write(`${message}\n`);
	};
	let stop: () => Promise<void>;
	if (values.host) {
		const port = Number(values.port);
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
		const host = await hostSwarm({
			name: values.name,
			directory,
			port,
			hostname: values.bind,
			repository: values.repo,
			base: values.base,
			remote: values.remote,
			command,
			onError,
		});
		console.log(
			`Agentcord hub: ${host.url}\nOpen your private owner link: ${host.guiUrl}\nKeep that link private. Use Share invite in the GUI for collaborators.\nEach project uses an isolated integration branch; your source checkout stays in place.`,
		);
		stop = host.stop;
	} else {
		const credential = await joinSwarm(values.join!, values.name, directory, values.token);
		const runnerDirectory = path.join(
			directory,
			"r",
			new Bun.CryptoHasher("sha256").update(credential.token).digest("hex").slice(0, 12),
		);
		const runner = new SwarmRunner({
			url: credential.url,
			token: credential.token,
			directory: runnerDirectory,
			command,
			onError,
		});
		await runner.start();
		console.log(
			`Runner connected: ${credential.url}\nYour GUI: ${credential.url}/#token=${credential.token}\nConfigure your roles in the GUI. Keep your member token private.`,
		);
		stop = () => runner.stop();
	}
	const shutdown = Promise.withResolvers<void>();
	process.once("SIGINT", () => shutdown.resolve());
	process.once("SIGTERM", () => shutdown.resolve());
	await shutdown.promise;
	await stop();
}

if (import.meta.main)
	main().catch(error => {
		process.stderr.write(`Agentcord: ${errorText(error)}\n`);
		process.exitCode = 1;
	});
