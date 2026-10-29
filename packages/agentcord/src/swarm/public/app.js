const $ = id => document.getElementById(id);
const roles = ["king", "queen", "worker", "testgen", "tester"];
let token = "",
	memberId = "",
	storageKey = "",
	state = null,
	socket = null,
	selectedProject = "";
let events = new Map(),
	reconnectTimer,
	noticeTimer;
const streams = new Map();

function notice(message, error = false) {
	$("notice").textContent = message;
	$("notice").classList.toggle("error", error);
	$("notice").hidden = false;
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(
		() => {
			$("notice").hidden = true;
		},
		error ? 12000 : 5000,
	);
}
async function api(route, body) {
	const response = await fetch(`/api/${route}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
	return result;
}
async function copyText(text) {
	try {
		if (!navigator.clipboard) throw new Error("Clipboard unavailable");
		await navigator.clipboard.writeText(text);
	} catch {
		$("copyValue").value = text;
		$("copyDialog").showModal();
		$("copyValue").focus();
		$("copyValue").select();
	}
}
function node(tag, className, text) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}
function pill(text) {
	return node("span", `pill ${text}`, text);
}
function me() {
	return state.members.find(member => member.id === memberId);
}
function agentName(id) {
	return (
		state.agents.find(agent => agent.id === id)?.name ||
		state.members.find(member => member.id === id)?.name ||
		id ||
		"Hub"
	);
}
function option(value, text) {
	const element = node("option", "", text);
	element.value = value;
	return element;
}
function updateOptions(select, choices, fallback = "") {
	const previous = select.value;
	select.replaceChildren(...choices.map(item => option(item.value, item.label)));
	select.value = choices.some(item => item.value === previous) ? previous : fallback || choices[0]?.value || "";
}
function capture(task) {
	return async event => {
		event?.preventDefault();
		try {
			await task(event);
		} catch (error) {
			notice(error.message, true);
		}
	};
}

async function connect() {
	const snapshot = await api("state");
	memberId = snapshot.memberId;
	state = snapshot.state;
	for (const entry of snapshot.events) events.set(entry.seq, entry);
	localStorage.setItem(storageKey, token);
	$("joinDialog").close();
	render();
	if (socket) {
		socket.onclose = null;
		socket.close();
	}
	const url = new URL("/ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	socket = new WebSocket(url, ["agentcord", token]);
	socket.onopen = () => {
		$("connection").textContent = "Live";
		$("connection").className = "pill online";
	};
	socket.onmessage = event => {
		const frame = JSON.parse(event.data);
		if (frame.type === "state") {
			state = frame.state;
			for (const entry of frame.events) events.set(entry.seq, entry);
			render();
		}
		if (frame.type === "event") {
			events.set(frame.event.seq, frame.event);
			renderEvent(frame.event);
		}
	};
	socket.onclose = () => {
		$("connection").textContent = "Reconnecting";
		$("connection").className = "pill";
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			connect().catch(error => notice(error.message, true));
		}, 2000);
	};
}

function render() {
	$("identity").textContent = me().name;
	$("inviteButton").hidden = !me().isHost;
	$("attachButton").hidden = !me().isHost;
	$("agentCount").textContent = `${state.agents.filter(agent => agent.online).length} online`;
	$("roster").replaceChildren();
	for (const member of state.members) {
		const group = node("div", "member");
		const title = node("div", "member-title");
		title.append(
			node("span", `dot ${member.online ? "online" : ""}`),
			node("span", "", member.name),
			node("span", "muted small", member.isHost ? "host" : "member"),
		);
		group.append(title);
		const agents = state.agents.filter(agent => agent.ownerId === member.id);
		for (const agent of agents) {
			const card = node("div", "agent");
			card.append(
				node("div", "agent-name", agent.role === "testgen" ? "Test generation" : agent.role),
				node("div", "model", agent.model),
			);
			if (agent.parentId) card.append(node("div", "parent", `↳ ${agentName(agent.parentId)}`));
			group.append(card);
		}
		if (!agents.length) group.append(node("p", "small muted", "Observer · no roles enabled"));
		$("roster").append(group);
	}
	updateOptions(
		$("projectSelect"),
		state.projects.map(project => ({ value: project.id, label: project.name })),
		selectedProject,
	);
	selectedProject = $("projectSelect").value;
	const project = state.projects.find(item => item.id === selectedProject);
	$("emptyProjects").hidden = !!project;
	$("repoStatus").textContent = project?.status || "No project";
	$("repoStatus").className = `pill ${project?.status || ""}`;
	$("repoStatus").title = project?.error || "";
	$("branchLink").textContent = project?.integrationBranch || "";
	$("branchLink").removeAttribute("href");
	$("revision").textContent = project?.head.slice(0, 10) || "";
	$("projectError").hidden = !project?.error;
	$("projectError").textContent = project?.error || "";
	$("reconcileButton").hidden = !me().isHost || project?.status !== "error";
	$("taskForm").querySelector("button").disabled = !project || project.status !== "ready";
	updateOptions(
		$("assignee"),
		state.agents
			.filter(agent => me().isHost || agent.ownerId === memberId || agent.role === "king")
			.map(agent => ({ value: agent.id, label: `${agent.name}${agent.online ? "" : " (offline)"}` })),
		state.agents.find(agent => agent.role === "king")?.id,
	);
	const choices = state.agents.map(agent => ({ value: agent.id, label: agent.name }));
	updateOptions($("activityAgent"), [{ value: "", label: "All agents" }, ...choices]);
	updateOptions($("messageTo"), [{ value: "", label: "Room chat" }, ...choices]);
	renderTasks();
	renderLog();
}
function renderTasks() {
	const tasks = state.tasks.filter(task => task.projectId === selectedProject).reverse();
	$("taskCount").textContent = `· ${tasks.length}`;
	$("tasks").replaceChildren();
	if (!tasks.length)
		$("tasks").append(node("div", "no-tasks", "No tasks yet. Submit a goal to your king to get started."));
	for (const task of tasks) {
		const card = node("article", "task-card"),
			top = node("div", "task-top");
		top.append(pill(task.status), node("span", "muted small", `#${task.id.slice(0, 6)} · try ${task.attempt}`));
		card.append(
			top,
			node("h3", "task-title", task.title),
			node("div", "task-meta", agentName(task.agentId)),
			node("div", "task-meta", task.paths.join(", ") || "Whole repository"),
		);
		if (task.parentTaskId) card.append(node("div", "task-meta", `Parent #${task.parentTaskId.slice(0, 6)}`));
		if (task.dependsOn.length)
			card.append(
				node("div", "task-meta", `Depends on ${task.dependsOn.map(id => `#${id.slice(0, 6)}`).join(", ")}`),
			);
		if (task.branch) card.append(node("div", "task-meta", task.branch));
		if (task.error) card.append(node("div", "task-error", task.error));
		const details = node("details");
		details.append(
			node("summary", "", "Instructions & result"),
			node("pre", "", `${task.instructions}\n\n${task.result || "Awaiting result"}`),
		);
		card.append(details);
		if (
			!["running", "waiting", "integrating", "completed"].includes(task.status) &&
			(me().isHost || state.agents.find(agent => agent.id === task.agentId)?.ownerId === memberId)
		) {
			const actions = node("div", "task-actions");
			for (const action of task.status === "queued" ? ["cancel"] : ["retry", "cancel"]) {
				const button = node("button", "", action === "retry" ? "Retry in new workspace" : "Cancel");
				button.addEventListener(
					"click",
					capture(() => api("task-action", { taskId: task.id, action })),
				);
				actions.append(button);
			}
			card.append(actions);
		}
		$("tasks").append(card);
	}
}
function visible(entry) {
	return (
		(!entry.projectId || entry.projectId === selectedProject) &&
		(!$("activityAgent").value || entry.agentId === $("activityAgent").value || entry.to === $("activityAgent").value)
	);
}
function renderLog() {
	$("activityLog").replaceChildren();
	streams.clear();
	for (const entry of [...events.values()].sort((a, b) => a.seq - b.seq).slice(-1200)) renderEvent(entry);
}
function renderEvent(entry) {
	if (!visible(entry)) return;
	const log = $("activityLog"),
		stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
	const data = entry.data;
	if (entry.kind === "agent_event" && data?.type === "message_update") {
		let stream = streams.get(entry.taskId);
		if (!stream) {
			stream = node("div", "log-entry");
			stream.append(node("div", "log-label", `${agentName(entry.agentId)} · streaming`), node("pre"));
			log.append(stream);
			streams.set(entry.taskId, stream);
		}
		stream.lastChild.textContent += data.delta || "";
	} else {
		if (data?.type === "message_end" && streams.has(entry.taskId)) {
			streams.get(entry.taskId).remove();
			streams.delete(entry.taskId);
		}
		const row = node("div", `log-entry ${data?.type || entry.kind}`);
		row.append(
			node(
				"div",
				"log-label",
				`${new Date(entry.time).toLocaleTimeString()} · ${agentName(entry.agentId || entry.memberId)}${entry.to ? ` → ${agentName(entry.to)}` : ""} · ${entry.kind}`,
			),
		);
		if (entry.text) row.append(node("div", "", entry.text));
		if (data) {
			if (data.type === "tool_execution_start")
				row.append(node("div", "", `▶ ${data.toolName}`), node("pre", "", JSON.stringify(data.args, null, 2)));
			else if (data.type === "message_end") {
				const message = data.message;
				row.append(
					node(
						"pre",
						"",
						typeof message?.content === "string"
							? message.content
							: (message?.content || [])
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n"),
					),
				);
			} else {
				const details = node("details");
				details.append(
					node("summary", "", `${data.toolName || data.type || "Details"}${data.isError ? " · ERROR" : ""}`),
					node("pre", "", JSON.stringify(data.result || data.partialResult || data, null, 2)),
				);
				row.append(details);
			}
		}
		log.append(row);
	}
	while (log.children.length > 600) log.firstChild.remove();
	if (stick) log.scrollTop = log.scrollHeight;
}
async function allHistory() {
	let after = 0;
	for (;;) {
		const page = await api(`events?after=${after}&limit=1000`);
		if (!page.length) break;
		for (const entry of page) events.set(entry.seq, entry);
		after = page.at(-1).seq;
		if (page.length < 1000) break;
	}
	return [...events.values()].sort((a, b) => a.seq - b.seq);
}

$("joinForm").addEventListener(
	"submit",
	capture(async () => {
		let invite = $("inviteInput").value.trim();
		if (invite.startsWith("http")) invite = new URLSearchParams(new URL(invite).hash.slice(1)).get("invite") || "";
		const result = await api("join", { name: $("joinName").value.trim(), invite });
		token = result.token;
		await connect();
		$("runnerDialog").showModal();
		renderRunner();
	}),
);
$("reconnectToken").addEventListener(
	"click",
	capture(async () => {
		token = $("existingToken").value.trim();
		if (!token) throw new Error("Paste your member token");
		await connect();
	}),
);
$("projectSelect").addEventListener("change", () => {
	selectedProject = $("projectSelect").value;
	render();
});
$("reconcileButton").addEventListener(
	"click",
	capture(async () => {
		await api("project-reconcile", { projectId: selectedProject });
		notice("Integration branch published. Review failed task branches, then retry them as needed.");
	}),
);
$("activityAgent").addEventListener("change", renderLog);
$("taskForm").addEventListener(
	"submit",
	capture(async () => {
		const instructions = $("goal").value.trim();
		await api("tasks", {
			projectId: selectedProject,
			agentId: $("assignee").value,
			title: instructions.slice(0, 120),
			instructions,
			paths: $("scope")
				.value.split(",")
				.map(value => value.trim())
				.filter(Boolean),
		});
		$("goal").value = "";
	}),
);
$("messageForm").addEventListener(
	"submit",
	capture(async () => {
		await api("message", { text: $("messageText").value.trim(), to: $("messageTo").value || undefined });
		$("messageText").value = "";
	}),
);
$("settingsButton").addEventListener("click", () => {
	$("roleFields").replaceChildren();
	for (const role of roles) {
		const settings = me().settings[role],
			field = node("div", "role-field"),
			title = node("div", "role-title"),
			label = node("label");
		const enabled = node("input");
		enabled.type = "checkbox";
		enabled.id = `enabled-${role}`;
		enabled.checked = settings.enabled;
		enabled.disabled = role === "king";
		label.append(enabled, document.createTextNode(role === "testgen" ? "Test generation" : role));
		title.append(label, node("span", "muted small", role === "king" ? "Host only · one per project" : "Optional"));
		const inputs = node("div", role === "worker" ? "role-inputs" : "role-inputs single"),
			modelLabel = node("label", "", "Model"),
			model = node("input");
		model.id = `model-${role}`;
		model.value = settings.model;
		model.required = true;
		model.placeholder = "provider/model or default";
		modelLabel.append(model);
		const countLabel = node("label", "", "Count"),
			count = node("input");
		count.id = `count-${role}`;
		count.type = "number";
		count.min = "1";
		count.max = role === "worker" ? "16" : "1";
		count.value = settings.count;
		count.disabled = role !== "worker";
		countLabel.hidden = role !== "worker";
		countLabel.append(count);
		inputs.append(modelLabel, countLabel);
		const instructionLabel = node("label", "", "Role instructions (optional)"),
			instructions = node("textarea");
		instructions.id = `instructions-${role}`;
		instructions.value = settings.instructions;
		instructions.maxLength = 10000;
		instructionLabel.append(instructions);
		const instructionDetails = node("details", "role-instructions");
		instructionDetails.append(node("summary", "", "Role instructions (optional)"), instructionLabel);
		field.append(title, inputs, instructionDetails);
		$("roleFields").append(field);
	}
	$("settingsDialog").showModal();
});
$("settingsForm").addEventListener(
	"submit",
	capture(async () => {
		const settings = {};
		for (const role of roles)
			settings[role] = {
				enabled: $(`enabled-${role}`).checked,
				model: $(`model-${role}`).value.trim(),
				count: Number($(`count-${role}`).value),
				instructions: $(`instructions-${role}`).value,
			};
		await api("settings", { settings });
		$("settingsDialog").close();
		notice("Your roles and models are saved.");
	}),
);
$("attachButton").addEventListener("click", () => $("projectDialog").showModal());
$("projectForm").addEventListener(
	"submit",
	capture(async () => {
		const button = $("projectForm").querySelector('button[type="submit"]');
		button.disabled = true;
		try {
			await api("projects", {
				name: $("projectName").value.trim(),
				directory: $("projectDirectory").value.trim(),
				baseRef: $("projectBase").value.trim(),
				remote: $("projectRemote").value.trim(),
			});
			$("projectDialog").close();
			notice("Project attached. Integration branch published.");
		} finally {
			button.disabled = false;
		}
	}),
);
$("inviteButton").addEventListener(
	"click",
	capture(async () => {
		const result = await api("invite");
		await copyText(`${location.origin}/#invite=${result.invite}`);
		notice("Invite copied. Use your LAN address or shared HTTPS address when inviting someone on another machine.");
	}),
);
function renderRunner() {
	$("runnerCommand").textContent = `bun run agentcord --join '${location.origin}' --token '${token}'`;
}
$("runnerButton").addEventListener("click", () => {
	renderRunner();
	$("runnerDialog").showModal();
});
$("copyRunner").addEventListener(
	"click",
	capture(async () => {
		await copyText($("runnerCommand").textContent);
		notice("Private runner command copied.");
	}),
);
document
	.querySelectorAll("[data-close]")
	.forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
$("historyButton").addEventListener(
	"click",
	capture(async () => {
		await allHistory();
		renderLog();
		notice("Journal loaded. Showing the latest 1,200 matching events; export includes the full journal.");
	}),
);
$("exportButton").addEventListener(
	"click",
	capture(async () => {
		const history = await allHistory(),
			link = node("a"),
			url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: "application/json" }));
		link.href = url;
		link.download = `agentcord-${state.roomId}.json`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}),
);

(async () => {
	try {
		const info = await api("info");
		storageKey = `agentcord-member-${info.roomId}`;
		const fragment = new URLSearchParams(location.hash.slice(1));
		token = fragment.get("token") || localStorage.getItem(storageKey) || "";
		const invite = fragment.get("invite");
		if (invite) $("inviteInput").value = invite;
		history.replaceState(null, "", location.pathname);
		if (token) {
			try {
				await connect();
				return;
			} catch (error) {
				notice(error.message, true);
			}
		}
		$("joinDialog").showModal();
	} catch (error) {
		notice(error.message, true);
	}
})();
