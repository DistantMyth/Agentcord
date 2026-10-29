import { expect, test } from "bun:test";
import { SwarmHub } from "../src/swarm/hub";
import { SwarmServer } from "../src/swarm/server";
import { SwarmStore } from "../src/swarm/store";
import type { ProjectRepository } from "../src/swarm/repository";
import { defaultSettings } from "../src/swarm/types";

test("HTTP identities protect role settings, invite links, and the activity journal", async () => {
	const repository: ProjectRepository = {
		attach: async () => {
			throw new Error("No project in this fixture");
		},
		integrate: async () => {
			throw new Error("No project in this fixture");
		},
	};
	const hub = new SwarmHub(new SwarmStore(":memory:"), repository, "Alice"),
		server = new SwarmServer(hub, { port: 0 });
	const url = server.start();
	const request = (route: string, token?: string, body?: unknown, origin?: string) =>
		fetch(`${url}/api/${route}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				"Content-Type": "application/json",
				...(origin ? { Origin: origin } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	try {
		expect((await request("state")).status).toBe(401);
		expect((await request("events")).status).toBe(401);
		expect((await request("join", undefined, { name: "Bob", invite: "wrong" })).status).toBe(401);
		const joined = await request("join", undefined, { name: "Bob", invite: hub.inviteToken });
		expect(joined.status).toBe(201);
		const bob = (await joined.json()) as { token: string };
		expect((await request("join", undefined, { name: "Alice", invite: hub.inviteToken })).status).toBe(400);
		expect((await request("invite", bob.token)).status).toBe(403);
		expect((await request("state", bob.token, undefined, "https://untrusted.example")).status).toBe(403);
		const settings = defaultSettings();
		settings.worker.model = "custom/bob-worker";
		expect((await request("settings", bob.token, { userName: "Alice", settings })).status).toBe(200);
		expect(hub.state.members.find(member => member.name === "Alice")?.settings.worker.model).toBe("default");
		expect(hub.state.members.find(member => member.name === "Bob")?.settings.worker.model).toBe("custom/bob-worker");
		settings.king.enabled = true;
		expect((await request("settings", bob.token, { settings })).status).toBe(400);
		expect(hub.state.agents.filter(agent => agent.role === "king").length).toBe(1);
		const page = await fetch(url);
		expect(await page.text()).toContain("Mission control");
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	} finally {
		await server.stop();
	}
});
