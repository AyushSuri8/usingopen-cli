import { isBunTestRuntime } from "@usingopen/utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
