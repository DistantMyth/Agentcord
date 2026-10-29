import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentcordBridge } from "../../coding-agent/src/agentcord/bridge";
import type { SwarmState } from "../src/swarm/types";

const bridges: AgentcordBridge[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const bridge of bridges.splice(0).reverse()) await bridge.stop();
	for (const directory of directories.splice(0)) {
		if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "agentcord-bridge-")))
			throw new Error("Invalid test directory");
		await fs.rm(directory, { recursive: true, force: true });
	}
});
async function bridge(name: string, isKing = true) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentcord-bridge-"));
	directories.push(directory);
	const instance = new AgentcordBridge({ userName: name, isKing, port: 0, directory });
	bridges.push(instance);
	return instance;
}
function identity(link: string) {
	const url = new URL(link);
	return { origin: url.origin, token: new URLSearchParams(url.hash.slice(1)).get("token")! };
}
async function snapshot(link: string): Promise<{ state: SwarmState; memberId: string }> {
	const info = identity(link);
	const response = await fetch(`${info.origin}/api/state`, { headers: { Authorization: `Bearer ${info.token}` } });
	return (await response.json()) as { state: SwarmState; memberId: string };
}

test("the terminal and browser share persistent per-member settings, and disabled roles survive restart", async () => {
	const host = await bridge("Alice"),
		link = await host.start();
	expect(await host.updateRoleModel("worker", "custom/worker-model")).toBe(true);
	let state = await snapshot(link);
	const member = state.state.members.find(item => item.id === state.memberId)!;
	expect(member.settings.worker.model).toBe("custom/worker-model");
	member.settings.queen.enabled = false;
	const info = identity(link);
	const update = await fetch(`${info.origin}/api/settings`, {
		method: "POST",
		headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ settings: member.settings }),
	});
	expect(update.ok).toBe(true);
	await host.stop();
	const restartedLink = await host.start();
	state = await snapshot(restartedLink);
	expect(state.state.members.find(item => item.id === state.memberId)?.settings.worker.model).toBe(
		"custom/worker-model",
	);
	expect(state.state.agents.some(agent => agent.role === "queen")).toBe(false);
	expect(state.state.agents.filter(agent => agent.role === "king").length).toBe(1);
	await expect(host.runStepTest()).rejects.toThrow("Attach a project");
});

test("joining a remote hub contributes real runner capacity without starting another king", async () => {
	const host = await bridge("Alice"),
		hostLink = await host.start(),
		info = identity(hostLink);
	const response = await fetch(`${info.origin}/api/invite`, { headers: { Authorization: `Bearer ${info.token}` } });
	const { invite } = (await response.json()) as { invite: string };
	const peer = await bridge("Bob", false);
	expect(await peer.connect(`${info.origin}/#invite=${invite}`)).toBe(true);
	const { state } = await snapshot(hostLink);
	expect(state.members.find(member => member.name === "Bob")?.online).toBe(true);
	expect(state.agents.filter(agent => agent.role === "king").map(agent => agent.ownerId)).toEqual([state.hostId]);
	await peer.sendChat("gc", undefined, "Connected from another terminal");
	const logResponse = await fetch(`${info.origin}/api/events`, { headers: { Authorization: `Bearer ${info.token}` } });
	const log = (await logResponse.json()) as Array<{ text?: string }>;
	expect(log.some(entry => entry.text === "Connected from another terminal")).toBe(true);
});
