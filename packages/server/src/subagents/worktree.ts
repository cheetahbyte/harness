import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type WorktreeLease = {
	workspace: string;
	path: string;
	branch?: string;
	baseCommit: string;
	createdBranch: boolean;
	agentId?: string;
};
export type WorktreeResult = {
	path?: string;
	branch?: string;
	baseCommit: string;
	changed: boolean;
};

async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err.trim() || `git ${args[0]} failed`);
	return out.trim();
}

export async function prepare(
	workspace: string,
	agentId: string,
	existingBranch?: string,
): Promise<WorktreeLease> {
	const root = await git(workspace, ["rev-parse", "--show-toplevel"]);
	const baseCommit = await git(root, ["rev-parse", "HEAD"]);
	if (!baseCommit)
		throw new Error("worktree requires a repository with at least one commit");
	const parent = join(tmpdir(), "harnez-worktrees");
	await mkdir(parent, { recursive: true });
	const path = join(
		parent,
		`${basename(root)}-${agentId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
	);
	if (existingBranch)
		await git(root, ["worktree", "add", path, existingBranch]);
	else await git(root, ["worktree", "add", "--detach", path, "HEAD"]);
	return {
		workspace: root,
		path,
		...(existingBranch ? { branch: existingBranch } : {}),
		baseCommit,
		createdBranch: false,
		agentId,
	};
}

export async function finish(lease: WorktreeLease): Promise<WorktreeResult> {
	const status = await git(lease.path, ["status", "--porcelain"]);
	const head = await git(lease.path, ["rev-parse", "HEAD"]);
	const changed = !!status || head !== lease.baseCommit;
	if (!changed) {
		await git(lease.workspace, ["worktree", "remove", "--force", lease.path]);
		return { baseCommit: lease.baseCommit, changed: false };
	}
	const branch =
		lease.branch ??
		`harnez-agent-${(lease.agentId ?? basename(lease.path)).slice(0, 8)}`;
	if (!lease.branch) await git(lease.path, ["switch", "-c", branch]);
	await git(lease.path, ["add", "-A"]);
	if (status)
		await git(lease.path, ["commit", "-m", `harnez: preserve subagent work`]);
	await git(lease.workspace, ["worktree", "remove", "--force", lease.path]);
	return { baseCommit: lease.baseCommit, branch, changed: true };
}
