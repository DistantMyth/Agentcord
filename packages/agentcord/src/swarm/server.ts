import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { SwarmHub } from "./hub";
import { errorText } from "./types";
import type { ClientFrame, ServerFrame, TaskInput } from "./types";

interface SocketData {
	memberId: string;
	runner: boolean;
	disconnect?: () => void;
}
export interface SwarmServerOptions {
	port: number;
	hostname?: string;
	guiPath?: string;
}

export class SwarmServer {
	#hub: SwarmHub;
	#options: SwarmServerOptions;
	#server?: Server<SocketData>;
	#sockets = new Set<ServerWebSocket<SocketData>>();
	#unsubscribe?: () => void;
	#timer?: NodeJS.Timeout;
	constructor(hub: SwarmHub, options: SwarmServerOptions) {
		this.#hub = hub;
		this.#options = options;
	}
	start(): string {
		const gui = path.resolve(this.#options.guiPath ?? path.join(import.meta.dir, "public"));
		this.#server = Bun.serve<SocketData>({
			port: this.#options.port,
			hostname: this.#options.hostname ?? "127.0.0.1",
			idleTimeout: 60,
			maxRequestBodySize: 262144,
			fetch: async (request, server) => {
				const url = new URL(request.url);
				try {
					const origin = request.headers.get("origin");
					if (origin && origin !== url.origin)
						return new Response("Cross-origin requests are not allowed", { status: 403 });
					if (url.pathname === "/ws") {
						const protocols =
							request.headers
								.get("sec-websocket-protocol")
								?.split(",")
								.map(item => item.trim()) ?? [];
						const memberId = this.#hub.authenticate(protocols[1] ?? "");
						if (
							server.upgrade(request, {
								data: { memberId, runner: url.searchParams.get("kind") === "runner" },
								headers: { "Sec-WebSocket-Protocol": "agentcord" },
							})
						)
							return;
						return new Response("WebSocket upgrade failed", { status: 400 });
					}
					if (url.pathname === "/api/info" && request.method === "GET")
						return Response.json({ version: 2, roomId: this.#hub.state.roomId });
					if (url.pathname === "/api/join" && request.method === "POST") {
						const input = (await request.json()) as { name?: unknown; invite?: unknown };
						if (typeof input.name !== "string" || typeof input.invite !== "string")
							throw new Error("Provide a member name and room invitation");
						return Response.json(this.#hub.join(input.name, input.invite), { status: 201 });
					}
					if (url.pathname.startsWith("/api/")) {
						const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
						const memberId = this.#hub.authenticate(token);
						if (url.pathname === "/api/state" && request.method === "GET")
							return Response.json({ state: this.#hub.state, memberId, events: this.#hub.store.recent() });
						if (url.pathname === "/api/events" && request.method === "GET") {
							const after = Number(url.searchParams.get("after") ?? 0);
							if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor");
							return Response.json(this.#hub.store.events(after, Number(url.searchParams.get("limit") ?? 200)));
						}
						if (url.pathname === "/api/invite" && request.method === "GET") {
							if (memberId !== this.#hub.state.hostId)
								return new Response("Only the host can share the invite", { status: 403 });
							return Response.json({ invite: this.#hub.inviteToken });
						}
						if (request.method !== "POST") return new Response("Not found", { status: 404 });
						const body = (await request.json()) as Record<string, unknown>;
						switch (url.pathname) {
							case "/api/settings":
								this.#hub.updateSettings(memberId, body.settings);
								break;
							case "/api/tasks":
								return Response.json(this.#hub.createTask(memberId, body as unknown as TaskInput), {
									status: 201,
								});
							case "/api/task-action": {
								if (typeof body.taskId !== "string" || (body.action !== "retry" && body.action !== "cancel"))
									throw new Error("Invalid task action");
								this.#hub.taskAction(memberId, body.taskId, body.action);
								break;
							}
							case "/api/message": {
								if (typeof body.text !== "string" || (body.to !== undefined && typeof body.to !== "string"))
									throw new Error("Invalid message");
								this.#hub.message(memberId, body.text, body.to);
								break;
							}
							case "/api/projects": {
								if (
									typeof body.directory !== "string" ||
									typeof body.name !== "string" ||
									typeof body.baseRef !== "string" ||
									(body.remote !== undefined && typeof body.remote !== "string")
								)
									throw new Error("Provide directory, name, baseRef, and optional remote");
								await this.#hub.attachProject(memberId, body.directory, body.name, body.baseRef, body.remote);
								break;
							}
							case "/api/project-reconcile": {
								if (typeof body.projectId !== "string") throw new Error("Provide a project ID");
								await this.#hub.reconcileProject(memberId, body.projectId);
								break;
							}
							case "/api/agent": {
								if (
									typeof body.taskId !== "string" ||
									typeof body.lease !== "string" ||
									typeof body.action !== "string" ||
									!body.input ||
									typeof body.input !== "object"
								)
									throw new Error("Invalid agent request");
								return Response.json(
									this.#hub.agentAction(
										memberId,
										body.taskId,
										body.lease,
										body.action,
										body.input as Record<string, unknown>,
									),
								);
							}
							default:
								return new Response("Not found", { status: 404 });
						}
						return Response.json({ ok: true });
					}
					const filePath = path.resolve(
						gui,
						`.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
					);
					if (!filePath.startsWith(gui + path.sep)) return new Response("Not found", { status: 404 });
					const file = Bun.file(filePath);
					if (!(await file.exists())) return new Response("Not found", { status: 404 });
					return new Response(file, {
						headers: {
							"X-Content-Type-Options": "nosniff",
							"Referrer-Policy": "no-referrer",
							"Content-Security-Policy":
								"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
							"Cache-Control": "no-store",
						},
					});
				} catch (error) {
					const message = errorText(error);
					return Response.json({ error: message }, { status: message.startsWith("Unauthorized") ? 401 : 400 });
				}
			},
			websocket: {
				maxPayloadLength: 262144,
				open: ws => {
					this.#sockets.add(ws);
					this.#send(ws, { type: "state", state: this.#hub.state, events: this.#hub.store.recent() });
					if (ws.data.runner)
						ws.data.disconnect = this.#hub.connectRunner(
							ws.data.memberId,
							assignment => this.#send(ws, { type: "assignment", assignment }),
							() => ws.close(4001, "Runner replaced or heartbeat expired"),
						);
				},
				message: (ws, raw) => {
					try {
						if (!ws.data.runner) throw new Error("Browser observers cannot claim runner tasks");
						const frame = JSON.parse(raw.toString()) as ClientFrame;
						if (frame.type === "heartbeat") {
							this.#hub.heartbeat(ws.data.memberId);
							return;
						}
						if (typeof frame.taskId !== "string" || typeof frame.lease !== "string")
							throw new Error("Invalid runner frame");
						if (frame.type === "activity")
							this.#hub.activity(ws.data.memberId, frame.taskId, frame.lease, frame.data);
						else if (frame.type === "result") {
							if (
								[frame.commit, frame.result, frame.error].some(
									value => value !== undefined && typeof value !== "string",
								)
							)
								throw new Error("Invalid result");
							void this.#hub
								.finish(ws.data.memberId, frame.taskId, frame.lease, frame)
								.catch(error => this.#send(ws, { type: "error", message: errorText(error) }));
						} else throw new Error("Unknown runner frame");
					} catch (error) {
						this.#send(ws, { type: "error", message: errorText(error) });
					}
				},
				close: ws => {
					this.#sockets.delete(ws);
					ws.data.disconnect?.();
				},
			},
		});
		this.#unsubscribe = this.#hub.subscribe((state, event) => {
			for (const socket of this.#sockets) {
				this.#send(socket, { type: "event", event });
				if (event.kind !== "agent_event") this.#send(socket, { type: "state", state, events: [] });
			}
		});
		this.#timer = setInterval(() => this.#hub.expire(), 10_000);
		return `http://127.0.0.1:${this.#server.port}`;
	}
	#send(socket: ServerWebSocket<SocketData>, frame: ServerFrame): void {
		socket.send(JSON.stringify(frame));
	}
	async stop(): Promise<void> {
		clearInterval(this.#timer);
		this.#unsubscribe?.();
		for (const socket of this.#sockets) socket.close(1001, "Hub stopping");
		this.#server?.stop(true);
		await this.#hub.close();
	}
}
