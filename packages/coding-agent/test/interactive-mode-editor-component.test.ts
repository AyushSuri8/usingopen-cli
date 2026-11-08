import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@usingopen/agent-core";
import { ModelRegistry } from "@usingopen/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@usingopen/coding-agent/config/settings";
import { CustomEditor } from "@usingopen/tui/prompt/custom-editor";
import { InteractiveMode } from "@usingopen/coding-agent/modes/interactive-mode";
import { initTheme } from "@usingopen/tui/theme";
import { AgentSession } from "@usingopen/coding-agent/session/agent-session";
import { AuthStorage } from "@usingopen/coding-agent/session/auth-storage";
import { SessionManager } from "@usingopen/coding-agent/session/session-manager";
import { TempDir } from "@usingopen/utils";

class TestModalEditor extends CustomEditor {}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("keeps the startup submit gate on an editor swapped in before init lifts it", () => {
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		expect(mode.editor.disableSubmit).toBe(true);

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		expect(mode.editor.disableSubmit).toBe(true);

		mode.editor.disableSubmit = false;
		mode.setEditorComponent(undefined);
		expect(mode.editor.disableSubmit).toBe(false);
	});
});
