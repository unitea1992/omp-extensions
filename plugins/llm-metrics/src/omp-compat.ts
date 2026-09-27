/**
 * Host-compat constants for llm-metrics.
 *
 * Marketplace-installed plugins run from the OMP plugin cache without their
 * own node_modules, so runtime value imports from OMP SDK subpaths
 * (`@oh-my-pi/pi-coding-agent/task/types`, ...) must not be required for the
 * extension to load. SDK deep paths also move between OMP releases, while the
 * EventBus channel names below are the stable runtime contract consumed via
 * `pi.events`. Keep this surface to plain string constants; all payload
 * shapes stay `import type` so the host types remain authoritative.
 */

/** EventBus channel for subagent progress (resolved model per subagent). */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end). */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
