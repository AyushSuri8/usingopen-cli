import * as path from "node:path";
import { Agent } from "@usingopen/agent-core";
import { createMockModel } from "@usingopen/ai/providers/mock";
import { getBundledModel } from "@usingopen/catalog/models";
import { ModelRegistry } from "@usingopen/coding-agent/config/model-registry";
import { Settings } from "@usingopen/coding-agent/config/settings";
import { runRpcMode } from "@usingopen/coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@usingopen/coding-agent/session/agent-session";
import { AuthStorage } from "@usingopen/coding-agent/session/auth-storage";
import { SessionManager } from "@usingopen/coding-agent/session/session-manager";

// Real RPC dispatch over a session persisted under the test's temp cwd; only model replies are scripted.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const mock = createMockModel({
	// A prompt mentioning "slow" stays in flight long enough for the test to act mid-stream.
	handler: context => ({
		content: ["Done"],
		delayMs: JSON.stringify(context.messages.at(-1)?.content).includes("slow") ? 1500 : 0,
	}),
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
await runRpcMode(session);
