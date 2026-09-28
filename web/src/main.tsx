import { createRoot } from "react-dom/client";
import "react-grid-layout/css/styles.css";
import "./styles.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
