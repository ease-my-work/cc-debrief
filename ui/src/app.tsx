// App shell: sidebar + the routed view (feature 12 client routes). Views arrive in Tasks 10-13.
import type { ReactNode } from "react";
import { Route, Switch } from "wouter";
import { EmptyState } from "./components/EmptyState";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { BackfillBar, Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { LiveStatusProvider } from "./lib/useLiveRefresh";
import { Activity } from "./routes/Activity";
import { Costs } from "./routes/Costs";
import { Overview } from "./routes/Overview";
import { Recap } from "./routes/Recap";
import { Repos } from "./routes/Repos";
import { Sessions } from "./routes/Sessions";
import { Settings } from "./routes/Settings";
import { SkillsTools } from "./routes/SkillsTools";
import { TasksPlans } from "./routes/TasksPlans";

function Placeholder({ title, note }: { title: string; note?: string }) {
	return (
		<>
			<TopBar title={title} />
			<EmptyState
				title={note ?? `${title} is not built yet`}
				command={null}
				hint="This view arrives in a later version."
			/>
		</>
	);
}

export function Layout({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-screen bg-background">
			<Sidebar />
			<KeyboardShortcuts />
			<main className="flex min-w-0 flex-grow flex-col gap-5 px-7 py-6">
				<BackfillBar />
				{children}
			</main>
		</div>
	);
}

export function App() {
	return (
		<LiveStatusProvider>
			<Layout>
				<Switch>
					<Route path="/">
						<Overview />
					</Route>
					<Route path="/activity">
						<Activity />
					</Route>
					<Route path="/costs">
						<Costs />
					</Route>
					<Route path="/sessions/:id?">{(params) => <Sessions id={params.id} />}</Route>
					<Route path="/skills">
						<SkillsTools />
					</Route>
					<Route path="/repos/:id?">{(params) => <Repos id={params.id} />}</Route>
					<Route path="/recap">
						<Recap />
					</Route>
					<Route path="/tasks">
						<TasksPlans />
					</Route>
					<Route path="/settings">
						<Settings />
					</Route>
					<Route>
						<Placeholder title="Not found" note="No such page" />
					</Route>
				</Switch>
			</Layout>
		</LiveStatusProvider>
	);
}
