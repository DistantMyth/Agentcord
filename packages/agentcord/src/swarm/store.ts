import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Activity, SwarmState } from "./types";

interface JsonRow {
	json: string;
}

/** One authoritative state and an ordered, replayable activity journal. */
export class SwarmStore {
	#db: Database;
	constructor(file: string) {
		if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
		this.#db = new Database(file, { create: true, strict: true });
		this.#db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (member_id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)",
		);
	}
	load(): SwarmState | null {
		const row = this.#db.query<JsonRow, []>("SELECT json FROM state WHERE id=1").get();
		return row ? (JSON.parse(row.json) as SwarmState) : null;
	}
	save(state: SwarmState): void {
		this.#db
			.query("INSERT INTO state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
			.run(JSON.stringify(state));
	}
	append(event: Omit<Activity, "seq" | "time">): Activity {
		const entry = { ...event, time: Date.now() };
		const result = this.#db.query("INSERT INTO events (json) VALUES (?)").run(JSON.stringify(entry));
		return { ...entry, seq: Number(result.lastInsertRowid) };
	}
	events(after = 0, limit = 200): Activity[] {
		const rows = this.#db
			.query<JsonRow & { seq: number }, [number, number]>(
				"SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
			)
			.all(after, Math.min(Math.max(limit, 1), 1000));
		return rows.map(row => ({ ...(JSON.parse(row.json) as Activity), seq: row.seq }));
	}
	commit(state: SwarmState, event: Omit<Activity, "seq" | "time">): Activity {
		return this.#db.transaction(() => {
			this.save(state);
			return this.append(event);
		})();
	}
	recent(): Activity[] {
		return this.#db
			.query<JsonRow & { seq: number }, []>("SELECT seq, json FROM events ORDER BY seq DESC LIMIT 200")
			.all()
			.reverse()
			.map(row => ({ ...(JSON.parse(row.json) as Activity), seq: row.seq }));
	}
	setCredential(memberId: string, token: string): void {
		this.#db
			.query("INSERT INTO credentials VALUES (?, ?) ON CONFLICT(member_id) DO UPDATE SET hash=excluded.hash")
			.run(memberId, new Bun.CryptoHasher("sha256").update(token).digest("hex"));
	}
	authenticate(token: string): string | undefined {
		const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
		return this.#db.query<{ member_id: string }, [string]>("SELECT member_id FROM credentials WHERE hash=?").get(hash)
			?.member_id;
	}
	meta(key: string, initialValue?: string): string | undefined {
		if (initialValue !== undefined) this.#db.query("INSERT OR IGNORE INTO meta VALUES (?, ?)").run(key, initialValue);
		return this.#db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value;
	}
	close(): void {
		this.#db.close();
	}
}
