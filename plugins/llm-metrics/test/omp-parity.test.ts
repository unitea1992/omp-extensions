import { describe, expect, test } from "bun:test";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL as localLifecycle,
	TASK_SUBAGENT_PROGRESS_CHANNEL as localProgress,
} from "../src/omp-compat";

describe("current OMP SDK manifest parity", () => {
	test("subagent EventBus channels match the current SDK", () => {
		expect(localProgress).toBe(TASK_SUBAGENT_PROGRESS_CHANNEL);
		expect(localLifecycle).toBe(TASK_SUBAGENT_LIFECYCLE_CHANNEL);
	});
});
