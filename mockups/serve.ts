// Serves mockups on ports 6001-6002
import { readFileSync } from "fs";
import { join } from "path";

const dir = import.meta.dir;
const sharedJs = readFileSync(join(dir, "shared.js"), "utf-8");

const mockups = [
  { port: 6001, file: "mockup5-chart-first.html", label: "Chart-First Main UI" },
  { port: 6002, file: "mockup6-sequence-editor.html", label: "Sequence Editor" },
];

for (const m of mockups) {
  const html = readFileSync(join(dir, m.file), "utf-8");
  Bun.serve({
    port: m.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/shared.js") {
        return new Response(sharedJs, { headers: { "content-type": "application/javascript" } });
      }
      // Serve the other mockup file for cross-linking
      for (const other of mockups) {
        if (url.pathname === "/" + other.file) {
          const otherHtml = readFileSync(join(dir, other.file), "utf-8");
          return new Response(otherHtml, { headers: { "content-type": "text/html" } });
        }
      }
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  console.log(`  ${m.label}: http://localhost:${m.port}`);
}

console.log("\nMockups running. Press Ctrl+C to stop.\n");
