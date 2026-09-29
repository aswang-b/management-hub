// GitHub: Actions runs, workflows, pull requests, issues, Dependabot alerts.
// API docs: https://docs.github.com/en/rest
import { ago, expectShape, optional, request, type Plugin, type PluginContext } from "./framework.ts";
import type { PluginItem, Tone } from "../../shared/types.ts";

const API = "https://api.github.com";

function gh<T = any>(ctx: PluginContext, path: string, init: { method?: string; body?: unknown; allow?: number[] } = {}) {
  return request<T>(`${API}${path}`, {
    ...init,
    service: "GitHub",
    tokenKey: "GITHUB_TOKEN",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${ctx.secret("GITHUB_TOKEN")}`,
      // Pinned API version, so GitHub changes don't silently alter responses.
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

function repoPath(ctx: PluginContext) {
  const repo = ctx.config.repo?.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Set the repository as owner/name, e.g. aswang-b/bachata-website.");
  return repo;
}

function runTone(status: string, conclusion: string | null): Tone {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "skipped") return "ok";
  if (conclusion === "cancelled" || conclusion === "neutral") return "neutral";
  return "bad";
}

export const github: Plugin = {
  id: "github",
  name: "GitHub",
  description: "Workflow runs, pull requests, issues and security alerts for one repository.",
  portalUrl: (c) => (c.repo ? `https://github.com/${c.repo}` : "https://github.com"),
  env: [
    {
      key: "GITHUB_TOKEN",
      help: "A fine-grained personal access token for the repositories you show in the hub.",
      url: "https://github.com/settings/personal-access-tokens/new",
      steps: [
        "Open GitHub's new fine-grained token page (sign in if asked).",
        "Name it \"Management hub\" and pick an expiration date.",
        "Under Repository access, choose \"Only select repositories\" and pick the repositories you'll add to the hub.",
        "Under Permissions, add these repository permissions: Actions (Read and write), Contents (Read-only), Pull requests (Read-only), Issues (Read-only), Dependabot alerts (Read-only). Metadata (Read-only) is added by itself.",
        "Press \"Generate token\", copy it (it starts with github_pat_) and paste it below. GitHub shows it only once.",
      ],
    },
  ],
  configFields: [{ key: "repo", label: "Repository", placeholder: "owner/name", required: true }],

  async load(ctx) {
    const repo = repoPath(ctx);
    const info = await gh(ctx, `/repos/${repo}`);
    expectShape(info && typeof info.default_branch === "string", "GitHub", "repository details");

    const [runs, pulls, workflows, alerts] = await Promise.all([
      gh(ctx, `/repos/${repo}/actions/runs?per_page=5`),
      gh<any[]>(ctx, `/repos/${repo}/pulls?state=open&per_page=50`),
      gh(ctx, `/repos/${repo}/actions/workflows?per_page=20`),
      // Dependabot may be off or the token may lack access. That's fine.
      optional(gh<any[]>(ctx, `/repos/${repo}/dependabot/alerts?state=open&per_page=100`)),
    ]);
    expectShape(Array.isArray(runs?.workflow_runs), "GitHub", "workflow runs");
    expectShape(Array.isArray(pulls), "GitHub", "pull requests");

    const runItems: PluginItem[] = runs.workflow_runs.map((r: any) => {
      const tone = runTone(r.status, r.conclusion);
      return {
        title: r.display_title || r.name,
        subtitle: `${r.name} · ${r.head_branch} · ${r.conclusion ?? r.status} · ${ago(r.created_at)}`,
        tone,
        url: r.html_url,
        actions:
          tone === "bad"
            ? [{ id: "rerunFailed", label: "Re-run failed", args: { runId: r.id } }]
            : r.status === "completed"
              ? [{ id: "rerun", label: "Re-run", args: { runId: r.id } }]
              : [],
      };
    });

    const latest = runs.workflow_runs[0];
    const issues = Math.max(0, info.open_issues_count - pulls.length); // GitHub counts PRs as issues
    const alertCount = alerts?.length;

    return {
      status: latest
        ? { label: `Last run: ${latest.conclusion ?? latest.status}`, tone: runTone(latest.status, latest.conclusion) }
        : { label: "No workflow runs", tone: "neutral" },
      stats: [
        { label: "Open PRs", value: String(pulls.length) },
        { label: "Open issues", value: String(issues) },
        ...(alertCount !== undefined
          ? [{ label: "Security alerts", value: String(alertCount), tone: (alertCount > 0 ? "warn" : "ok") as Tone }]
          : []),
        { label: "Last push", value: ago(info.pushed_at) },
      ],
      sections: [
        { title: "Recent runs", items: runItems, empty: "No workflow runs yet." },
        {
          title: "Open pull requests",
          items: pulls.slice(0, 5).map((p: any) => ({
            title: `#${p.number} ${p.title}`,
            subtitle: `${p.user?.login ?? ""} · ${ago(p.updated_at)}${p.draft ? " · draft" : ""}`,
            url: p.html_url,
          })),
          empty: "No open pull requests.",
        },
        {
          title: "Workflows",
          items: (workflows?.workflows ?? [])
            .filter((w: any) => w.state === "active")
            .map((w: any) => ({
              title: w.name,
              subtitle: w.path,
              url: w.html_url,
              actions: [
                {
                  id: "dispatch",
                  label: "Run",
                  args: { workflowId: w.id, ref: info.default_branch },
                  confirm: `Run "${w.name}" on ${info.default_branch}?`,
                },
              ],
            })),
          empty: "No workflows.",
        },
      ],
      links: [
        { label: "Actions", url: `https://github.com/${repo}/actions` },
        { label: "Issues", url: `https://github.com/${repo}/issues` },
        { label: "Security", url: `https://github.com/${repo}/security` },
      ],
    };
  },

  actions: {
    async rerunFailed(ctx, { runId }) {
      await gh(ctx, `/repos/${repoPath(ctx)}/actions/runs/${Number(runId)}/rerun-failed-jobs`, { method: "POST" });
      return "Re-running failed jobs.";
    },
    async rerun(ctx, { runId }) {
      await gh(ctx, `/repos/${repoPath(ctx)}/actions/runs/${Number(runId)}/rerun`, { method: "POST" });
      return "Re-running workflow.";
    },
    async dispatch(ctx, { workflowId, ref }) {
      try {
        await gh(ctx, `/repos/${repoPath(ctx)}/actions/workflows/${Number(workflowId)}/dispatches`, {
          method: "POST",
          body: { ref: String(ref) },
        });
      } catch (e) {
        if ((e as Error).message.includes("workflow_dispatch")) {
          throw new Error("This workflow can't be started by hand. Add `workflow_dispatch:` to its `on:` triggers first.");
        }
        throw e;
      }
      return "Workflow started.";
    },
  },
};
