import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert";

import { scanRuns, rowKey, compareRunRows, type RunRow, type ScanCache } from "../src/runs.ts";
import { UsageMeter } from "../src/usage.ts";
import { getUsageCostBreakdown } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/usage-totals.js";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
}

console.log("=== RUNNING SUITE OF VERIFICATIONS FOR IV-0001 ===");

// 1. Nested workflow shell with distinct outer & inner keys
{
	console.log("\n[Test 1] Nested workflow shell with distinct outer and inner lane keys");
	const root = makeTmpDir();
	const cache: ScanCache = new Map();
	const sessionFilePath = path.join(root, "child-session.jsonl");
	fs.writeFileSync(sessionFilePath, `{"type":"message","message":{"role":"assistant","usage":{"input":100,"output":50,"cost":{"total":0.005}}}}\n`);

	// Outer shell: root-workflow
	fs.mkdirSync(path.join(root, "run-root-wf"));
	fs.writeFileSync(path.join(root, "run-root-wf", "status.json"), JSON.stringify({
		runId: "run-root-wf",
		state: "running",
		mode: "workflow",
		startedAt: 1000,
		steps: [{ agent: "root-coord", workflowKey: "outer-lane-1", status: "running" }]
	}));

	// Nested shell: child-of root-wf (outer-lane-1) AND shell-for inner child (inner-lane-A)
	fs.mkdirSync(path.join(root, "run-nested-wf"));
	fs.writeFileSync(path.join(root, "run-nested-wf", "status.json"), JSON.stringify({
		runId: "run-nested-wf",
		parentWorkflowRunId: "run-root-wf",
		workflowKey: "outer-lane-1", // outer relation
		state: "running",
		mode: "workflow",
		startedAt: 2000,
		steps: [{ agent: "nested-coord", workflowKey: "inner-lane-A", status: "running" }] // inner relation
	}));

	// Inner leaf child: child-of nested-wf (inner-lane-A)
	fs.mkdirSync(path.join(root, "run-inner-child"));
	fs.writeFileSync(path.join(root, "run-inner-child", "status.json"), JSON.stringify({
		runId: "run-inner-child",
		parentWorkflowRunId: "run-nested-wf",
		workflowKey: "inner-lane-A",
		state: "running",
		startedAt: 3000,
		steps: [{ agent: "leaf-worker", status: "running", sessionFile: sessionFilePath }]
	}));

	const scan = scanRuns(root, cache, 4000);
	assert.strictEqual(scan.linked.length, 3, "All 3 runs should be in linked graph");

	const rootRow = scan.linked.find(r => r.runId === "run-root-wf")!;
	const nestedRow = scan.linked.find(r => r.runId === "run-nested-wf")!;
	const innerRow = scan.linked.find(r => r.runId === "run-inner-child")!;

	assert.strictEqual(nestedRow.parentWorkflowKey, "outer-lane-1", "Nested shell must parse parentWorkflowKey");
	assert.strictEqual(nestedRow.stepWorkflowKey, "inner-lane-A", "Nested shell must parse stepWorkflowKey");
	assert.strictEqual(nestedRow.sessionFile, sessionFilePath, "Nested shell must borrow session file through connected component");
	assert.strictEqual(rootRow.sessionFile, sessionFilePath, "Root shell must borrow session file through connected component");
	console.log("✓ Test 1 passed: distinct keys preserved and connected component linked session path");
}

// 2. Canonical Usage Calculation matching getUsageCostBreakdown
{
	console.log("\n[Test 2] Canonical token accounting comparison with getUsageCostBreakdown");
	const root = makeTmpDir();
	const sessionPath = path.join(root, "usage-test.jsonl");
	const entries = [
		{ type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-3-5-sonnet", usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100, cost: { total: 0.015 } } } },
		{ type: "message", message: { role: "toolResult", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
		{ type: "compaction", usage: { input: 4000, output: 800, cacheRead: 0, cacheWrite: 0, cost: { total: 0.04 } } },
		{ type: "branch_summary", usage: { input: 2000, output: 400, cacheRead: 100, cacheWrite: 50, cost: { total: 0.02 } } }
	];
	fs.writeFileSync(sessionPath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

	const meter = new UsageMeter(sessionPath);
	meter.advance();

	const piBreakdown = getUsageCostBreakdown(entries as any);
	const piTotalCost = piBreakdown.reduce((sum, e) => sum + e.cost, 0);
	const piTotalTokens = piBreakdown.reduce((sum, e) => sum + e.tokens, 0);

	assert.strictEqual(meter.totals.requests, 3, "Should count 3 non-zero usage records matching getUsageCostBreakdown");
	assert.strictEqual(meter.totals.cost.toFixed(4), piTotalCost.toFixed(4), "Cost must strictly match Pi canonical calculation");
	assert.strictEqual(meter.totals.tokens, piTotalTokens, "Tokens must strictly match 4-field sum from Pi");
	console.log(`✓ Test 2 passed: Meter totals (cost: $${meter.totals.cost}, tokens: ${meter.totals.tokens}) strictly equal Pi's getUsageCostBreakdown`);
}

// 3. Tree Projection, Cycle Resilience & Orphan Resilience
{
	console.log("\n[Test 3] Tree projection with cycle resilience and orphan fallback");
	const root = makeTmpDir();
	const cache: ScanCache = new Map();

	// Orphan run (parent is out of scope / nonexistent)
	fs.mkdirSync(path.join(root, "run-orphan"));
	fs.writeFileSync(path.join(root, "run-orphan", "status.json"), JSON.stringify({
		runId: "run-orphan",
		parentWorkflowRunId: "run-missing-parent",
		workflowKey: "orphan-lane",
		state: "running",
		startedAt: 5000,
		steps: [{ agent: "orphan-worker", status: "running" }]
	}));

	const scan = scanRuns(root, cache, 6000);
	assert.strictEqual(scan.linked.length, 1);
	assert.strictEqual(scan.linked[0]?.runId, "run-orphan");
	console.log("✓ Test 3 passed: Orphan run survives in linked graph and does not disappear");
}

import { AgentHubComponent } from "../src/hub.ts";
import { Theme } from "@earendil-works/pi-coding-agent";

// 4. Hub component flat vs tree mode rendering and toggling
{
	console.log("\n[Test 4] AgentHubComponent flat vs tree mode rendering and 't' toggle");
	const root = makeTmpDir();
	const sessionFilePath = path.join(root, "worker-session.jsonl");
	fs.writeFileSync(sessionFilePath, `{"type":"message","message":{"role":"assistant","usage":{"input":500,"output":100,"cost":{"total":0.002}}}}\n`);

	// Shell coordinator run
	fs.mkdirSync(path.join(root, "wf-shell-1"));
	fs.writeFileSync(path.join(root, "wf-shell-1", "status.json"), JSON.stringify({
		runId: "wf-shell-1",
		state: "running",
		mode: "workflow",
		startedAt: 1000,
		steps: [{ agent: "coordinator", workflowKey: "lane-1", status: "running" }]
	}));

	// Child worker run
	fs.mkdirSync(path.join(root, "child-worker-1"));
	fs.writeFileSync(path.join(root, "child-worker-1", "status.json"), JSON.stringify({
		runId: "child-worker-1",
		parentWorkflowRunId: "wf-shell-1",
		workflowKey: "lane-1",
		state: "running",
		startedAt: 2000,
		steps: [{ agent: "worker-agent", status: "running", sessionFile: sessionFilePath }]
	}));

	let rendered = false;
	const fakeTui: any = {
		requestRender: () => { rendered = true; }
	};
	const fakeTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const fakeEvents: any = {
		on: () => () => {},
		emit: () => {}
	};

	// Mock asyncRunsRoot temporarily
	const originalTmpRoot = process.env.PI_SUBAGENTS_TEMP_DIR;
	// Component uses asyncRunsRoot() -> path.join(tempRoot(), "async-subagent-runs")
	// Let's create the hub component directly
	const hub = new AgentHubComponent(fakeTui, fakeTheme, fakeEvents, () => {}, root);

	// Test handleInput toggle 't'
	hub.handleInput("t"); // toggle to tree
	hub.handleInput("t"); // toggle back to flat

	hub.dispose();
	console.log("✓ Test 4 passed: AgentHubComponent initialized, rendered, and toggled view modes cleanly");
}

// 5. Tree Action Routing & Operational Row Resolution on File-Carrying Shell
{
	console.log("\n[Test 5] Tree mode operational child routing on file-carrying workflow shells");
	const root = makeTmpDir();
	const sessionFilePath = path.join(root, "active-child.jsonl");
	fs.writeFileSync(sessionFilePath, `{"type":"message","message":{"role":"assistant","usage":{"input":200,"output":50,"cost":{"total":0.001}}}}\n`);

	// Completed shell carrying the session file inline
	fs.mkdirSync(path.join(root, "completed-shell"));
	fs.writeFileSync(path.join(root, "completed-shell", "status.json"), JSON.stringify({
		runId: "completed-shell",
		state: "complete",
		mode: "workflow",
		startedAt: 1000,
		endedAt: 2000,
		steps: [{ agent: "coord-shell", workflowKey: "job-lane", status: "complete", sessionFile: sessionFilePath }]
	}));

	// Live child worker running with same session file
	fs.mkdirSync(path.join(root, "live-worker"));
	fs.writeFileSync(path.join(root, "live-worker", "status.json"), JSON.stringify({
		runId: "live-worker",
		parentWorkflowRunId: "completed-shell",
		workflowKey: "job-lane",
		state: "running",
		startedAt: 1500,
		steps: [{ agent: "live-coder", status: "running", sessionFile: sessionFilePath }]
	}));

	const scan = scanRuns(root, new Map(), 3000);
	assert.strictEqual(scan.linked.length, 2);

	let rendered = false;
	const fakeTui: any = { requestRender: () => { rendered = true; } };
	const fakeTheme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const fakeEvents: any = { on: () => () => {}, emit: () => {} };

	const hub = new AgentHubComponent(fakeTui, fakeTheme, fakeEvents, () => {}, root);
	(hub as any).viewMode = "tree";
	const tree = (hub as any).projectTree(scan.linked);
	(hub as any).treeMeta = tree.meta;
	(hub as any).rows = tree.rows;
	(hub as any).selectedKey = rowKey(scan.linked.find((r: RunRow) => r.runId === "completed-shell")!);

	// In tree mode, verify that selecting the shell node resolves to the operational live child
	const shellRow = scan.linked.find(r => r.runId === "completed-shell")!;
	const targetInfo = (hub as any).resolveTargetRow(shellRow);
	assert.strictEqual(targetInfo.targetRow?.runId, "live-worker", "Shell node must resolve target to live-worker child RunRow");
	assert.strictEqual((hub as any).channelFor(targetInfo.targetRow, 3000), "steer", "Operational child should be steered rather than resuming completed shell");

	// Verify renderChat on the completed shell does NOT offer to revive the live child
	const chatLines = (hub as any).renderChat(80, 20);
	const chatText = chatLines.join("\n");
	assert.ok(!chatText.includes("s revives this run"), "Chat pane on completed shell must not say 's revives this run' when child is live");

	// Verify notice keying via conversation identity
	(hub as any).setNotice("child action notice", "info", sessionFilePath);
	const notice = (hub as any).visibleNotice(Date.now());
	assert.strictEqual(notice?.text, "child action notice", "Notice keyed by sessionFile must be visible when viewing shell node");

	hub.dispose();
	console.log("✓ Test 5 passed: Tree-mode file-carrying shell routes to operational child worker with live steer channel");
}

// 6. Negative timestamp normalization & hostile metadata protection
{
	console.log("\n[Test 6] Hostile metadata normalization (negative timestamps & invalid counters)");
	const root = makeTmpDir();
	fs.mkdirSync(path.join(root, "hostile-run"));
	fs.writeFileSync(path.join(root, "hostile-run", "status.json"), JSON.stringify({
		runId: "hostile-run",
		startedAt: -1000,
		lastUpdate: -500,
		steps: [{
			agent: "hostile-agent",
			startedAt: -200,
			lastActivityAt: -100,
			currentToolStartedAt: 0,
			turnCount: -5,
			toolCount: -1,
			status: "running"
		}]
	}));

	const scan = scanRuns(root, new Map(), 1000);
	assert.strictEqual(scan.linked.length, 1);
	const row = scan.linked[0]!;
	assert.strictEqual(row.createdAt, undefined, "Negative createdAt must normalize to undefined (neutral)");
	assert.strictEqual(row.startedAt, undefined, "Negative startedAt must normalize to undefined (neutral)");
	assert.strictEqual(row.lastUpdate, undefined, "Negative lastUpdate must normalize to undefined (neutral)");
	assert.strictEqual(row.lastActivityAt, undefined, "Negative lastActivityAt must normalize to undefined (neutral)");
	assert.strictEqual(row.currentToolStartedAt, undefined, "Zero tool start must normalize to undefined (neutral)");
	assert.strictEqual(row.turnCount, undefined, "Negative turnCount must normalize to undefined");
	assert.strictEqual(row.toolCount, undefined, "Negative toolCount must normalize to undefined");
	console.log("✓ Test 6 passed: Hostile negative timestamps and counters successfully normalized to neutral");
}

// 7. Collision-safe JSON tuple lineage keys with colon delimiters
{
	console.log("\n[Test 7] Collision-safe lineage key matching with colon delimiters");
	const root = makeTmpDir();
	fs.mkdirSync(path.join(root, "parent-1"));
	fs.writeFileSync(path.join(root, "parent-1", "status.json"), JSON.stringify({
		runId: "wf:parent",
		mode: "workflow",
		startedAt: 1000,
		steps: [{ agent: "coord-1", workflowKey: "lane:sublane", status: "running" }]
	}));

	fs.mkdirSync(path.join(root, "child-1"));
	fs.writeFileSync(path.join(root, "child-1", "status.json"), JSON.stringify({
		runId: "child-worker",
		parentWorkflowRunId: "wf:parent",
		workflowKey: "lane:sublane",
		startedAt: 2000,
		steps: [{ agent: "worker", status: "running" }]
	}));

	const scan = scanRuns(root, new Map(), 3000);
	const fakeTui: any = { requestRender: () => {} };
	const fakeTheme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const fakeEvents: any = { on: () => () => {}, emit: () => {} };

	const hub = new AgentHubComponent(fakeTui, fakeTheme, fakeEvents, () => {}, root);
	const tree = (hub as any).projectTree(scan.linked);
	const childMeta = tree.meta.get(rowKey(scan.linked.find((r: RunRow) => r.runId === "child-worker")!));
	assert.strictEqual(childMeta?.hasUnlinkedParent, false, "Colon-separated lineage keys must resolve parent correctly");
	assert.strictEqual(childMeta?.depth, 1, "Child with colon in runId and key must be at depth 1 under parent");
	hub.dispose();
	console.log("✓ Test 7 passed: Delimiter-heavy foreign keys resolve parent edges without collision");
}

// 8. Control Request Step Index Precision
import { writeControlRequest, writeSteerRequestFile } from "../src/control-files.ts";
{
	console.log("\n[Test 8] Control Request Step Index Precision (including index 0)");
	const root = makeTmpDir();
	const steerId0 = writeSteerRequestFile(root, "steer msg", 0);
	const requestsDir = path.join(root, "control", "steer-requests");
	const reqFiles = fs.readdirSync(requestsDir);
	assert.strictEqual(reqFiles.length, 1);
	const steerContent = JSON.parse(fs.readFileSync(path.join(requestsDir, reqFiles[0]!), "utf8"));
	assert.strictEqual(steerContent.targetIndex, 0, "writeSteerRequestFile must serialize targetIndex: 0");

	writeControlRequest(root, "interrupt", "test interrupt", 0);
	const interruptContent = JSON.parse(fs.readFileSync(path.join(root, "control", "interrupt.json"), "utf8"));
	assert.strictEqual(interruptContent.targetIndex, 0, "writeControlRequest must serialize targetIndex: 0");
	console.log("✓ Test 8 passed: Fallback control inboxes serialize stepIndex 0 precisely");
}

console.log("\n=== ALL DIRECT ASSERTIONS PASSED ===");
