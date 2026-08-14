// pi-agent-hub: watch the agents another extension runs in the background —
// their full conversations, live — from a floating hub. /hub opens it.
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type OverlayOptions } from "@earendil-works/pi-tui";
import { AgentHubComponent, overlayGeometry, SIZE_PRESETS } from "./hub.ts";
import type { RpcEvents } from "./rpc.ts";
import { clampSize, readSavedSize, saveSize } from "./settings.ts";

const SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "pi-agent-hub.json");

export default function agentHubExtension(pi: ExtensionAPI): void {
	let open = false;

	const showHub = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		if (open) {
			ctx.ui.notify("Agent hub is already open.", "info");
			return;
		}
		open = true;
		try {
			const size = readSavedSize(SETTINGS_FILE);
			const geometry = overlayGeometry(size);
			// pi keeps a reference to this object and re-resolves the layout
			// from it every frame, so the z key resizes the open panel by
			// mutating it in place — no remount, no lost state. maxHeight
			// stays "100%": the component's render() owns the height.
			const overlayOptions: OverlayOptions = {
				anchor: "center",
				width: geometry.width,
				minWidth: 70,
				maxHeight: "100%",
				margin: geometry.margin,
			};
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new AgentHubComponent(tui, theme, pi.events as unknown as RpcEvents, done, ctx.cwd, size, next => {
						saveSize(SETTINGS_FILE, next);
						const resized = overlayGeometry(next);
						overlayOptions.width = resized.width;
						overlayOptions.margin = resized.margin;
					}),
				{
					overlay: true,
					overlayOptions,
				},
			);
		} finally {
			open = false;
		}
	};

	pi.registerCommand("hub", {
		description: "Open the agent hub: watch background agents' conversations live (/hub 40-100 sets its size)",
		handler: async (args, ctx) => {
			const arg = args?.trim();
			// Only a session that can SHOW the result may change the size: a
			// headless /hub 55 used to write the preference and say nothing —
			// the one feedback-free path through the feature was the one that
			// wrote to disk.
			if (arg && ctx.hasUI) {
				const parsed = Number.parseInt(arg, 10);
				if (Number.isFinite(parsed) && parsed >= 40 && parsed <= 100) {
					saveSize(SETTINGS_FILE, clampSize(parsed));
				} else if (ctx.hasUI) {
					ctx.ui.notify(`Hub size is a percentage, 40-100 (z cycles ${SIZE_PRESETS.join("/")} inside).`, "warning");
				}
			}
			await showHub(ctx);
		},
	});

	// omp opens its hub on alt+a; same reflex here. Registered through pi's
	// shortcut API — the layer that owns global keys — so this is the one
	// binding of ours that works EVERYWHERE in pi, not only inside the overlay.
	// (On macOS the terminal must send Option as Meta for alt+a to arrive.)
	pi.registerShortcut(Key.alt("a"), {
		description: "Open the agent hub",
		handler: async ctx => showHub(ctx),
	});
}
