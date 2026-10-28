// Tool categories (Phase 7 P10, feature 03): a fixed map of Claude Code's built-in tools; any call with an MCP server
// is "mcp"; a tool not listed is "other".
export const TOOL_CATEGORIES = [
	"file_read",
	"file_edit",
	"search",
	"shell",
	"web",
	"agents",
	"tasks_plans",
	"skills",
	"mcp",
	"other",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

const MAP: Record<string, ToolCategory> = {
	Read: "file_read",
	NotebookRead: "file_read",
	Edit: "file_edit",
	Write: "file_edit",
	MultiEdit: "file_edit",
	NotebookEdit: "file_edit",
	Grep: "search",
	Glob: "search",
	LS: "search",
	ToolSearch: "search",
	Bash: "shell",
	PowerShell: "shell",
	BashOutput: "shell",
	KillShell: "shell",
	Monitor: "shell",
	WebFetch: "web",
	WebSearch: "web",
	// The desktop app's Artifact tool publishes a hosted page.
	Artifact: "web",
	Agent: "agents",
	Task: "agents",
	SendMessage: "agents",
	ListAgents: "agents",
	TaskOutput: "agents",
	TaskStop: "agents",
	SubagentHandback: "agents",
	TaskCreate: "tasks_plans",
	TaskUpdate: "tasks_plans",
	TaskList: "tasks_plans",
	TaskGet: "tasks_plans",
	TodoWrite: "tasks_plans",
	EnterPlanMode: "tasks_plans",
	ExitPlanMode: "tasks_plans",
	Skill: "skills",
};

export function toolCategory(name: string, mcpServer: string | null): ToolCategory {
	if (mcpServer) return "mcp";
	return MAP[name] ?? "other";
}
