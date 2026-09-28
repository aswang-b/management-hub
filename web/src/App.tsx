import { useEffect, useMemo, useState } from "react";
import type { PluginMeta, Project } from "../../shared/types.ts";
import { api } from "./api.ts";
import { buildRegistry } from "./tools/registry.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { ProjectSettings } from "./components/ProjectSettings.tsx";
import { Modal } from "./components/Modal.tsx";

const projectFromHash = () => Number(location.hash.match(/^#\/p\/(\d+)/)?.[1]) || undefined;

export function App() {
  const [projects, setProjects] = useState<Project[]>();
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [currentId, setCurrentId] = useState(projectFromHash());
  const [building, setBuilding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const registry = useMemo(() => buildRegistry(plugins), [plugins]);

  useEffect(() => {
    Promise.all([api.projects(), api.plugins()])
      .then(([p, pl]) => {
        setProjects(p);
        setPlugins(pl);
      })
      .catch(() => setError("Can't reach the hub's server. Is it running? (npm start)"));
    const onHash = () => setCurrentId(projectFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const current = projects?.find((p) => p.id === currentId) ?? projects?.[0];
  const go = (id: number) => {
    location.hash = `/p/${id}`;
    setCurrentId(id);
  };

  async function createProject(name: string) {
    const p = await api.createProject(name);
    setProjects((ps) => [...(ps ?? []), p]);
    setCreating(false);
    go(p.id);
    setBuilding(true);
  }

  return (
    <div className="app">
      <header className="nav">
        <span className="brand">HUB</span>
        <nav className="tabs">
          {projects?.map((p) => (
            <a key={p.id} href={`#/p/${p.id}`} className={p.id === current?.id ? "active" : ""}>
              {p.name}
            </a>
          ))}
          <button className="tab-add" onClick={() => setCreating(true)} title="New project">
            + New
          </button>
        </nav>
        {current && (
          <div className="nav-actions">
            <button className={`btn ${building ? "btn-primary" : ""}`} onClick={() => setBuilding(!building)}>
              {building ? "Done" : "Build"}
            </button>
            <button className="btn" onClick={() => setShowSettings(true)} title="Project settings">
              ⚙
            </button>
          </div>
        )}
      </header>

      <main>
        {error && <div className="empty-state">{error}</div>}
        {projects && projects.length === 0 && (
          <div className="empty-state">
            <p>No projects yet.</p>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Create your first project
            </button>
          </div>
        )}
        {current && <Workspace key={current.id} project={current} registry={registry} building={building} />}
      </main>

      {creating && <NewProject onCreate={createProject} onClose={() => setCreating(false)} />}
      {showSettings && current && (
        <ProjectSettings
          project={current}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            const p = await api.updateProject(current.id, patch);
            setProjects((ps) => ps?.map((x) => (x.id === p.id ? p : x)));
            setShowSettings(false);
          }}
          onDelete={async () => {
            await api.deleteProject(current.id);
            setProjects((ps) => ps?.filter((x) => x.id !== current.id));
            setShowSettings(false);
            setBuilding(false);
            location.hash = "";
            setCurrentId(undefined);
          }}
        />
      )}
    </div>
  );
}

function NewProject({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <Modal title="New project" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bachata Website" autoFocus required />
        </label>
        <div className="form-actions">
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
