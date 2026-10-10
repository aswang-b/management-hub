import { createRoot } from "react-dom/client";
import "react-grid-layout/css/styles.css";
import "./styles.css";
import { App } from "./App.tsx";

// In the installed app with the title bar hidden, the window buttons take
// the theme color: white makes them blend into the header (phones keep black).
const overlay = matchMedia("(display-mode: window-controls-overlay)");
const themeColor = () =>
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", overlay.matches ? "#ffffff" : "#000000");
themeColor();
overlay.addEventListener("change", themeColor);

createRoot(document.getElementById("root")!).render(<App />);
