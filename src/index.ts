// pi-agent-hub: watch the agents another extension runs in the background —
// their full conversations, live — from a floating hub. /hub opens it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { AgentHubComponent } from "./hub.ts";
import type { RpcEvents } from "./rpc.ts";

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
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) => new AgentHubComponent(tui, theme, pi.events as unknown as RpcEvents, done, ctx.cwd),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "96%", minWidth: 70, maxHeight: "90%", margin: 1 },
				},
			);
		} finally {
			open = false;
		}
	};

	pi.registerCommand("hub", {
		description: "Open the agent hub: watch background agents' conversations live",
		handler: async (_args, ctx) => showHub(ctx),
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
