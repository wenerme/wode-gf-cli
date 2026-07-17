import fs from "node:fs";
import path from "node:path";

const Roots = ["src", "scripts"];
const Extensions = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const GeneratedFiles = new Set([path.normalize("src/promql/parser.js")]);
const MaximumLines = 500;
const WarningLines = 450;

function collectFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(target));
    else if (entry.isFile() && Extensions.has(path.extname(entry.name))) files.push(target);
  }
  return files;
}

function countLines(file) {
  const content = fs.readFileSync(file, "utf8");
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

const measured = Roots.flatMap(collectFiles)
  .filter((file) => !GeneratedFiles.has(path.normalize(file)))
  .map((file) => ({ file, lines: countLines(file) }))
  .sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));
const oversized = measured.filter(({ lines }) => lines > MaximumLines);
const warnings = measured.filter(({ lines }) => lines > WarningLines && lines <= MaximumLines);

for (const { file, lines } of warnings) console.warn(`[LOC] warning ${lines}: ${file}`);
for (const { file, lines } of oversized) console.error(`[LOC] limit ${lines}: ${file}`);

if (oversized.length > 0) {
  console.error(`[LOC] ${oversized.length} hand-written file(s) exceed ${MaximumLines} lines`);
  process.exitCode = 1;
} else {
  console.log(`[LOC] checked ${measured.length} hand-written files; limit ${MaximumLines}`);
}
