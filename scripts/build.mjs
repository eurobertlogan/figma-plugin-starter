#!/usr/bin/env node
/**
 * Pipeline de build do plugin.
 *
 * O Figma carrega exatamente dois arquivos (veja manifest.json): um único
 * `code.js` sem imports e, opcionalmente, um arquivo HTML para o iframe. É
 * exatamente por isso que este script existe: ele pega o código-fonte dividido
 * em TypeScript/React e produz esses dois artefatos achatados, mais uma cópia
 * do manifest.
 *
 *   node scripts/build.mjs           build único
 *   node scripts/build.mjs --watch   rebuild a cada mudança
 *
 * Tudo passa pelo esbuild duas vezes:
 *
 *   1. sandbox  src/main.ts   -> dist/code.js   (IIFE, es2017, sem minificar)
 *   2. UI       src/ui/*.tsx  -> dist/ui.html   (JS + CSS embutidos em um arquivo)
 *
 * Os dois builds usam `write: false`, então a saída só chega ao disco pelos
 * handlers `onEnd` abaixo. Um único caminho de código atende tanto o build
 * único quanto o modo watch, o que evita que os dois divirjam.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";

import * as esbuild from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const manifestPath = path.join(root, "manifest.json");
const isWatch = process.argv.includes("--watch");

/** Opções compartilhadas pelos dois bundles. */
const shared = {
  bundle: true,
  // Os arquivos gerados são escritos pelos plugins abaixo, não pelo esbuild.
  write: false,
  logLevel: "silent",
  // O Figma roda Chromium, mas es2017 é um piso seguro e mantém a saída pequena.
  target: "es2017",
  // Mantém os comentários de licença de terceiros (React é MIT) no fim do
  // bundle.
  legalComments: "eof",
  define: {
    // O React lê isto em runtime; sem isso a UI lança
    // "process is not defined" dentro do iframe.
    "process.env.NODE_ENV": '"production"',
  },
};

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`.padStart(8);
}

function logFile(label, bytes) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${time}  ${label.padEnd(18)}${formatSize(bytes)}`);
}

/**
 * O documento do iframe. CSS e JS são embutidos porque o plugin não tem
 * acesso à rede (`"allowedDomains": ["none"]`) e o Figma só serve os arquivos
 * listados no manifest.
 */
function renderHtml({ css, js }) {
  // Um `</script>` literal dentro do bundle fecharia a tag antes da hora. A
  // forma escapada é JS válido e inerte para o parser de HTML.
  const safeJs = js.replaceAll("</script", "<\\/script");
  const safeCss = css.replaceAll("</style", "<\\/style");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rename layers</title>
    <style>${safeCss}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${safeJs}</script>
  </body>
</html>
`;
}

/**
 * Escreve dist/manifest.json.
 *
 * O Figma resolve `main` e `ui` relativos ao arquivo do manifest, então a
 * cópia em dist/ não pode manter o prefixo `dist/`: importar
 * dist/manifest.json precisa encontrar `code.js` ao lado dele. O manifest do
 * repositório mantém o prefixo, o que também faz a importação do manifest da
 * raiz funcionar. Os dois pontos de entrada resolvem para os mesmos arquivos.
 *
 * Retorna o tamanho do arquivo escrito.
 */
async function writeManifest() {
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  const rebased = { ...source };

  for (const key of ["main", "ui"]) {
    if (typeof rebased[key] === "string") {
      rebased[key] = rebased[key].replace(/^dist\//, "");
    }
  }

  const contents = `${JSON.stringify(rebased, null, 2)}\n`;
  await writeFile(path.join(dist, "manifest.json"), contents);

  return Buffer.byteLength(contents);
}

/**
 * Envolve um handler de saída para que ele rode após cada build que der certo,
 * incluindo cada rebuild no modo watch.
 *
 * Os dois bundles compartilham módulos (o core e a camada de mensagens), então
 * um erro de sintaxe derruba os dois builds e seria impresso duas vezes. A
 * formatação é cacheada para imprimir cada erro distinto uma vez por build
 * verde.
 */
const printedErrors = new Set();

function writeOnEnd(name, handler) {
  return {
    name,
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) {
          // logLevel é "silent", então imprimimos os diagnósticos nós mesmos;
          // um erro de sintaxe não pode te deixar olhando para um dist/
          // desatualizado sem motivo.
          process.exitCode = 1;
          const messages = await esbuild.formatMessages(result.errors, {
            kind: "error",
            color: true,
          });

          for (const message of messages) {
            if (!printedErrors.has(message)) {
              printedErrors.add(message);
              console.error(message);
            }
          }
          return;
        }

        printedErrors.clear();

        try {
          await handler(result.outputFiles ?? []);
        } catch (error) {
          process.exitCode = 1;
          console.error(`[${name}] ${error instanceof Error ? error.message : error}`);
        }
      });
    },
  };
}

/** dist/code.js + dist/manifest.json */
const writeSandbox = writeOnEnd("sandbox", async (outputs) => {
  const code = outputs.find((file) => file.path.endsWith("code.js"));
  if (!code) {
    throw new Error("esbuild did not emit code.js");
  }

  await writeFile(code.path, code.text);
  const manifestBytes = await writeManifest();
  logFile("dist/code.js", code.contents.length);
  logFile("dist/manifest.json", manifestBytes);
});

/** dist/ui.html, com o bundle da UI e seu CSS embutidos. */
const writeUi = writeOnEnd("ui", async (outputs) => {
  const js = outputs.find((file) => file.path.endsWith(".js"));
  const css = outputs.find((file) => file.path.endsWith(".css"));
  if (!js) {
    throw new Error("esbuild did not emit the UI bundle");
  }

  const html = renderHtml({ js: js.text, css: css?.text ?? "" });
  await writeFile(path.join(dist, "ui.html"), html);
  logFile("dist/ui.html", Buffer.byteLength(html));
});

const sandboxOptions = {
  ...shared,
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(dist, "code.js"),
  format: "iife",
  // O sandbox não tem window/document, então não assuma plataforma de
  // navegador.
  platform: "neutral",
  // Legível de propósito: é esta a metade que você depura no console do Figma.
  minify: false,
  plugins: [writeSandbox],
};

const uiOptions = {
  ...shared,
  entryPoints: [path.join(root, "src/ui/index.tsx")],
  outdir: dist,
  entryNames: "ui",
  assetNames: "ui-[name]",
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  // A UI é React; minificar mantém o HTML embutido em tamanho razoável.
  minify: true,
  loader: { ".css": "css" },
  plugins: [writeUi],
};

async function main() {
  const started = Date.now();

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const [sandboxContext, uiContext] = await Promise.all([
    esbuild.context(sandboxOptions),
    esbuild.context(uiOptions),
  ]);

  if (isWatch) {
    await Promise.all([sandboxContext.watch(), uiContext.watch()]);

    // Nenhum arquivo-fonte importa manifest.json, então o esbuild não o vê.
    // Observe-o separadamente e recopie após cada salvamento.
    watch(manifestPath, async () => {
      try {
        const bytes = await writeManifest();
        logFile("dist/manifest.json", bytes);
      } catch (error) {
        console.error(`manifest copy failed: ${error instanceof Error ? error.message : error}`);
      }
    });

    console.log("Watching src/ and manifest.json. Re-run the plugin in Figma to load changes.");

    const stop = async () => {
      await Promise.all([sandboxContext.dispose(), uiContext.dispose()]);
      process.exit(0);
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  try {
    await Promise.all([sandboxContext.rebuild(), uiContext.rebuild()]);
  } catch {
    // O esbuild rejeita rebuild() no primeiro bundle que falha. Os
    // diagnósticos já foram impressos pelo onEnd, que também definiu o código
    // de saída.
    process.exitCode = 1;
  } finally {
    await Promise.all([sandboxContext.dispose(), uiContext.dispose()]);
  }

  if (process.exitCode === 1) {
    console.error("Build failed.");
    process.exit(1);
  }

  console.log(`\nBuilt in ${Date.now() - started} ms`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
