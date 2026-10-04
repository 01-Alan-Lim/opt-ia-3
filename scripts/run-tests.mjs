// scripts/run-tests.mjs

// Corre las pruebas de src/lib/plan una por una con tsx, en el orden de siempre, y se detiene
// en la primera que falle (con su código de salida).
//
// Por qué no una cadena "tsx a && tsx b && …" en package.json: en Windows npm ejecuta el script
// con cmd.exe /d /s /c y cada tsx es un .cmd. Con 15 archivos (673 caracteres) ese proceso se
// colgaba antes de terminar el primero; con 8 (338 caracteres) terminaba en segundos. Aquí cada
// prueba se lanza con node directamente, sin cmd ni el .cmd de tsx.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const TESTS = [
  "paretoCut",
  "paretoParsing",
  "whyQuality",
  "whyList",
  "ishikawaRoots",
  "ishikawaBranchFlow",
  "ishikawaServerFields",
  "ishikawaRootRegistry",
  "ishikawaWhyInterpreter",
  "ishikawaWhyIntake",
  "ishikawaResume",
  "ishikawaTurnRouter",
  "ishikawaPromptContext",
  "ishikawaRootDeferred",
  "stageAuthority",
  "ishikawaE4Simulation",
  "advisorClientIntent",
  "stage0Context",
].map((name) => path.join("src", "lib", "plan", `${name}.test.ts`));

for (const file of TESTS) {
  const result = spawnSync(process.execPath, [tsxCli, file], { cwd: root, stdio: "inherit" });

  if (result.error) {
    console.error(`No se pudo ejecutar ${file}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`Falló ${file} (código ${result.status ?? result.signal}).`);
    process.exit(result.status ?? 1);
  }
}
