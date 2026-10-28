import { z } from "zod";

/**
 * A Claude Code hook payload (Phase 0 B1). Permissive: only session_id and hook_event_name are required; every
 * other field, including surface-specific extras, passes through unchanged. SessionEnd carries `reason`
 * (prompt_input_exit | clear | other | …), SessionStart `source` (startup | resume | clear | compact | fork).
 */
export const HookPayload = z.looseObject({
	session_id: z.string().min(1),
	hook_event_name: z.string().min(1),
	transcript_path: z.string().optional(),
	cwd: z.string().optional(),
	source: z.string().optional(),
	reason: z.string().optional(),
	tool_name: z.string().optional(),
	last_assistant_message: z.string().optional(),
});

export type HookPayload = z.infer<typeof HookPayload>;
