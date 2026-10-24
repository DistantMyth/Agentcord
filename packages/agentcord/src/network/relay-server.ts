import type { ServerWebSocket } from "bun";
import * as path from "node:path";
import type { AgentRegistry } from "../agents";
import type { ChatRoom } from "../chat";
import type { AgentMemoryStore } from "../memory";
import type { ModelConfigManager } from "../models";
import type { AgentInfo, ChatMessage, QuestionEscalation, TestCase, TestRunResult, UserInfo } from "../types";
import type { WireFrame } from "./protocol";

export interface RelayServerOptions {
	port: number;
	host?: string;
	roomId?: string;
	hostUser: string;
	registry: AgentRegistry;
	chatRoom: ChatRoom;
	modelManager: ModelConfigManager;
	memoryStore: AgentMemoryStore;
	guiPath?: string;
}

interface SocketData {
	userName?: string;
	roomId: string;
	isHost: boolean;
}

export class AgentcordRelayServer {
	private readonly port: number;
	private readonly host: string;
	readonly roomId: string;
	private readonly hostUser: string;
	private readonly registry: AgentRegistry;
	private readonly chatRoom: ChatRoom;
	private readonly modelManager: ModelConfigManager;
	private readonly memoryStore: AgentMemoryStore;
	private readonly guiPath: string;

	private readonly sockets = new Set<ServerWebSocket<SocketData>>();
	private readonly users = new Map<string, UserInfo>();
	private readonly testCases: TestCase[] = [];
	private readonly testRuns: TestRunResult[] = [];
	private server: any = null;

	constructor(opts: RelayServerOptions) {
		this.port = opts.port;
		this.host = opts.host || "0.0.0.0";
		this.roomId = opts.roomId || `room_${Math.random().toString(36).slice(2, 8)}`;
		this.hostUser = opts.hostUser;
		this.registry = opts.registry;
		this.chatRoom = opts.chatRoom;
		this.modelManager = opts.modelManager;
		this.memoryStore = opts.memoryStore;
		this.guiPath = opts.guiPath || path.resolve(__dirname, "..", "gui", "public");

		// Register host user
		this.users.set(this.hostUser, {
			name: this.hostUser,
			isHost: true,
			connectedAt: Date.now(),
		});

		// Listen to chat room events and broadcast
		this.chatRoom.subscribeMessages(msg => {
			this.broadcast({ type: "chat_message", message: msg });
		});

		this.chatRoom.subscribeQuestions(q => {
			this.broadcast({ type: "question_escalation", question: q });
		});

		// Listen to registry events and broadcast
		this.registry.subscribe(agents => {
			for (const agent of agents) {
				this.broadcast({ type: "agent_update", agent });
			}
		});
	}

	start(): { url: string; port: number; roomId: string } {
		const self = this;
		this.server = Bun.serve<SocketData>({
			port: this.port,
			hostname: this.host,
			fetch(req, srv) {
				const url = new URL(req.url);

				// WebSocket upgrade
				if (url.pathname === "/ws") {
					const room = url.searchParams.get("room") || self.roomId;
					const user = url.searchParams.get("user") || "";
					const isHost = user === self.hostUser;

					const success = srv.upgrade(req, {
						data: {
							userName: user,
							roomId: room,
							isHost,
						},
					});
					if (success) return undefined;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}

				// API Endpoints
				if (url.pathname === "/api/state") {
					return Response.json(self.getFullState());
				}

				if (url.pathname === "/api/models") {
					return Response.json(self.modelManager.getAvailableModels());
				}

				// GUI Static Files
				let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
				const fullPath = path.join(self.guiPath, filePath);
				const file = Bun.file(fullPath);
				return new Response(file);
			},
			websocket: {
				open(ws: ServerWebSocket<SocketData>) {
					self.sockets.add(ws);
				},
				message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
					try {
						const raw = typeof message === "string" ? message : message.toString();
						const frame = JSON.parse(raw) as WireFrame;
						self.handleClientFrame(ws, frame);
					} catch (err) {
						console.error("Failed to handle frame:", err);
					}
				},
				close(ws: ServerWebSocket<SocketData>) {
					self.sockets.delete(ws);
					if (ws.data.userName) {
						self.users.delete(ws.data.userName);
						self.broadcast({ type: "peer_left", userName: ws.data.userName });
					}
				},
			},
		});

		const actualPort = this.server.port;
		const displayUrl = `http://localhost:${actualPort}`;
		return {
			url: displayUrl,
			port: actualPort,
			roomId: this.roomId,
		};
	}

	stop(): void {
		if (this.server) {
			this.server.stop();
			this.server = null;
		}
		for (const ws of this.sockets) {
			ws.close();
		}
		this.sockets.clear();
	}

	broadcast(frame: WireFrame): void {
		const payload = JSON.stringify(frame);
		for (const ws of this.sockets) {
			try {
				ws.send(payload);
			} catch {
				// Socket closed or error
			}
		}
	}

	addTestCase(tc: TestCase): void {
		this.testCases.push(tc);
		this.broadcast({ type: "test_created", testCase: tc });
	}

	addTestRun(run: TestRunResult): void {
		this.testRuns.push(run);
		this.broadcast({ type: "test_run", result: run });
	}

	getFullState() {
		return {
			roomId: this.roomId,
			hostUser: this.hostUser,
			users: Array.from(this.users.values()),
			agents: this.registry.getSnapshots(),
			messages: this.chatRoom.getMessages(),
			questions: this.chatRoom.getQuestions(),
			testCases: this.testCases,
			testRuns: this.testRuns,
		};
	}

	private handleClientFrame(ws: ServerWebSocket<SocketData>, frame: WireFrame): void {
		switch (frame.type) {
			case "hello": {
				const user = frame.userName.trim() || "guest";
				ws.data.userName = user;
				const userInfo: UserInfo = {
					name: user,
					isHost: user === this.hostUser,
					connectedAt: Date.now(),
					queenModel: frame.queenModel,
					workerModel: frame.workerModel,
					testgenModel: frame.testgenModel,
					testerModel: frame.testerModel,
				};
				this.users.set(user, userInfo);

				// Send welcome snapshot to this newly connected client
				const welcome: WireFrame = {
					type: "welcome",
					roomId: this.roomId,
					hostUser: this.hostUser,
					users: Array.from(this.users.values()),
					agents: this.registry.getSnapshots(),
					messages: this.chatRoom.getMessages(),
					questions: this.chatRoom.getQuestions(),
					testCases: this.testCases,
					testRuns: this.testRuns,
				};
				ws.send(JSON.stringify(welcome));

				// Broadcast to all other peers
				this.broadcast({
					type: "peer_joined",
					user: userInfo,
					agents: this.registry.getAgentsByOwner(user).map(a => a.getSnapshot()),
				});
				break;
			}

			case "chat_message": {
				this.chatRoom.sendMessage(frame.message);
				break;
			}

			case "question_escalation": {
				this.chatRoom.submitQuestion(
					frame.question.fromAgent,
					frame.question.toAgent,
					frame.question.question
				);
				break;
			}

			case "model_update": {
				if (frame.agentId) {
					this.registry.updateModel(frame.agentId, frame.model);
				}
				if (frame.userName && frame.role) {
					this.modelManager.setUserModels(frame.userName, {
						[`${frame.role}Model`]: frame.model,
					} as any);
				}
				this.broadcast(frame);
				break;
			}

			case "test_created": {
				this.addTestCase(frame.testCase);
				break;
			}

			case "test_run": {
				this.addTestRun(frame.result);
				break;
			}
		}
	}
}
