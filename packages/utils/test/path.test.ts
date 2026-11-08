import { describe, expect, it } from "bun:test";
import { isFullyQualifiedPath, stripWindowsExtendedLengthPathPrefix, windowsPathToWslMount } from "../src/path";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\usingopen.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\usingopen.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\usingopen.exe", "win32")).toBe(
			"\\\\server\\share\\usingopen.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\usingopen.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("windowsPathToWslMount", () => {
	it("clamps parent traversal at the Windows drive root", () => {
		expect(windowsPathToWslMount("C:\\..\\Windows\\x")).toBe("/mnt/c/Windows/x");
	});

	it("rejects paths without an absolute Windows drive", () => {
		expect(windowsPathToWslMount("/home/me/file.txt")).toBeUndefined();
	});
});

describe("isFullyQualifiedPath", () => {
	it("identifies fully qualified Windows paths across platforms", () => {
		expect(isFullyQualifiedPath("C:\\usingopen\\bin\\usingopen.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("c:/usingopen/bin/usingopen.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("\\\\server\\share\\usingopen.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("//server/share/usingopen.exe", "win32")).toBe(true);
		expect(isFullyQualifiedPath("C:usingopen", "win32")).toBe(false);
		expect(isFullyQualifiedPath(".\\usingopen", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\bin\\usingopen", "win32")).toBe(false);
		expect(isFullyQualifiedPath("/bin/usingopen", "win32")).toBe(false);
		expect(isFullyQualifiedPath("//", "win32")).toBe(false);
		expect(isFullyQualifiedPath("\\\\", "win32")).toBe(false);
	});

	it("identifies absolute POSIX paths", () => {
		expect(isFullyQualifiedPath("/usr/local/bin/usingopen", "darwin")).toBe(true);
		expect(isFullyQualifiedPath("/usr/local/bin/usingopen", "linux")).toBe(true);
		expect(isFullyQualifiedPath("./usingopen", "darwin")).toBe(false);
		expect(isFullyQualifiedPath("usingopen", "linux")).toBe(false);
	});
});
