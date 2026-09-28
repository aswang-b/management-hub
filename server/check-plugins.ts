// `npm run check-plugins`: loads every plugin tile in every project and
// reports which ones work. Use it after a service changes its API, or
// when a tile shows an error, to find which plugin file needs fixing.
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

const db = await import("./db.ts");
const { getPlugin, runLoad, runCollect } = await import("./plugins/index.ts");

let failures = 0;
let checked = 0;
for (const project of db.listProjects()) {
  for (const tool of db.listTools(project.id).filter((t) => t.category === "plugin")) {
    const plugin = getPlugin(tool.type);
    if (!plugin) {
      console.log(`✕ ${project.name} / ${tool.type}: no such plugin`);
      failures++;
      continue;
    }
    const r = await runLoad(plugin, tool.id, tool.config, true);
    checked++;
    if (r.ok) console.log(`✓ ${project.name} / ${plugin.name}`);
    else {
      failures++;
      console.log(`✕ ${project.name} / ${plugin.name} [${r.errorKind}]: ${r.error}`);
    }
    // The numbers saved for analytics tiles come from a separate step.
    if (plugin.collect) {
      const c = await runCollect(plugin, tool.config);
      if (c.ok) console.log(`  ✓ analytics: ${c.points.map((p) => p.metric).join(", ") || "no numbers"}`);
      else {
        failures++;
        console.log(`  ✕ analytics numbers: ${c.error}`);
      }
    }
  }
}
console.log(checked ? `\n${checked - failures} of ${checked} plugin tiles working.` : "No plugin tiles to check.");
process.exit(failures ? 1 : 0);
