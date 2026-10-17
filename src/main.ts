/**
 * Sandbox do plugin (a metade `code.js`).
 *
 * Roda em um contexto JS sem DOM: `document`, `window` e `parent` não existem
 * aqui. Tudo que é visual vive no iframe da UI e as duas metades só conversam
 * através das mensagens tipadas em `src/shared/messages.ts`.
 */

import { planRename, type CaseTransform, type RenameFailure } from "./core/rename";
import {
  assertNever,
  sendToUi,
  onUiMessage,
  type RenameScope,
  type SelectionSummary,
} from "./shared/messages";

const UI_SIZE = { width: 380, height: 580 } as const;

figma.showUI(__html__, {
  ...UI_SIZE,
  title: "Rename layers",
  // Injeta as variáveis CSS `--figma-color-*` para a UI seguir o modo
  // claro/escuro.
  themeColors: true,
});

// ---------------------------------------------------------------------------
// Seleção
// ---------------------------------------------------------------------------

interface TargetBatch {
  nodes: SceneNode[];
  summary: SelectionSummary;
}

/**
 * Contêineres têm os filhos renomeados; todo o resto é renomeado em si mesmo.
 *
 * `in` é o que estreita `SceneNode` para os membros que de fato têm
 * `children`, e um cast para `any` aqui é o motivo usual de plugins quebrarem
 * em uma camada de texto ou vetor.
 */
function isContainer(node: SceneNode): node is SceneNode & ChildrenMixin {
  return "children" in node && Array.isArray(node.children);
}

/**
 * Lê a seleção atual e a resolve nas camadas que serão renomeadas. Note que
 * `figma.currentPage.selection` é um array somente leitura, então copie antes de
 * ordenar ou mutar.
 */
function collectTargets(): TargetBatch {
  const selection = figma.currentPage.selection;
  const nodes: SceneNode[] = [];
  const seen = new Set<string>();
  let containers = 0;

  const add = (node: SceneNode): void => {
    if (seen.has(node.id)) {
      return;
    }
    seen.add(node.id);
    nodes.push(node);
  };

  for (const node of selection) {
    if (isContainer(node)) {
      containers += 1;
      // Instâncias também são contêineres, mas seus filhos são somente
      // leitura. As tentativas falham e são reportadas de volta em vez de
      // não fazerem nada silenciosamente.
      for (const child of node.children) {
        add(child);
      }
    } else {
      add(node);
    }
  }

  // "children" apenas quando toda camada selecionada é um contêiner; "mixed"
  // quando a seleção tem contêineres e folhas (ambos são renomeados).
  let scope: RenameScope = "layer";
  if (selection.length > 0 && containers === selection.length) {
    scope = "children";
  } else if (containers > 0) {
    scope = "mixed";
  }

  return {
    nodes,
    summary: {
      selectedCount: selection.length,
      targetCount: nodes.length,
      scope,
      names: nodes.map((node) => node.name),
    },
  };
}

function pushSelection(): void {
  sendToUi({ type: "selection", selection: collectTargets().summary });
}

// ---------------------------------------------------------------------------
// Renomeação
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renameSelection(pattern: string, transform: CaseTransform): void {
  const { nodes } = collectTargets();

  if (nodes.length === 0) {
    figma.notify("Nothing to rename. Select a layer, or a frame with children.");
    pushSelection();
    return;
  }

  const plan = planRename({
    names: nodes.map((node) => node.name),
    pattern,
    transform,
  });

  if (!plan.ok) {
    sendToUi({ type: "error", message: plan.error });
    figma.notify(plan.error, { error: true });
    return;
  }

  const failures: RenameFailure[] = [];
  let renamed = 0;

  plan.entries.forEach((entry, index) => {
    const node = nodes[index];
    if (!node) {
      return;
    }

    // Nós podem desaparecer entre a chegada da mensagem e a escrita (undo,
    // outro plugin, um colega em multiplayer), então cheque antes de tocar.
    if (node.removed) {
      failures.push({ layer: entry.original, reason: "Layer no longer exists." });
      return;
    }

    try {
      node.name = entry.name;
      renamed += 1;
    } catch (error) {
      // Nós travados, filhos de instância somente leitura e casos parecidos
      // falham aqui. Uma camada ruim não pode abortar o lote inteiro.
      failures.push({ layer: entry.original, reason: describeError(error) });
    }
  });

  const suffix = renamed === 1 ? "" : "s";
  if (failures.length === 0) {
    figma.notify(`Renamed ${renamed} layer${suffix}.`);
  } else {
    figma.notify(`Renamed ${renamed} layer${suffix}, ${failures.length} failed.`, {
      error: true,
    });
  }

  sendToUi({ type: "renamed", renamed, failures });

  // Os nomes mudaram, então o preview que a UI mantém está desatualizado.
  pushSelection();

  // Deliberadamente sem figma.closePlugin() aqui: renomear é repetível, e a
  // janela fechar após o primeiro clique é um bug esperando para acontecer.
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

const unsubscribe = onUiMessage((message) => {
  switch (message.type) {
    case "ready":
      pushSelection();
      break;
    case "rename":
      renameSelection(message.pattern, message.transform);
      break;
    case "cancel":
      figma.closePlugin();
      break;
    default:
      // Inalcançável em runtime (o parser rejeita tipos desconhecidos); é isso
      // que faz uma nova variante de mensagem virar erro de compilação em vez
      // de código morto.
      assertNever(message);
  }
});

// ---------------------------------------------------------------------------
// Ligação de eventos
// ---------------------------------------------------------------------------

figma.on("selectionchange", pushSelection);
figma.on("currentpagechange", pushSelection);

figma.on("close", () => {
  unsubscribe();
});

// ---------------------------------------------------------------------------
// Helpers de referência da API
//
// Não usados pelo exemplo: documentação executável das armadilhas que pegam
// quase todo plugin. Eles são exportados de propósito, para que o esbuild os
// mantenha no bundle e você possa ler a versão compilada em dist/code.js.
// ---------------------------------------------------------------------------

/**
 * Texto é o único tipo de nó que você não consegue mutar sem carregar a fonte
 * antes. `node.characters = "..."` lança "Cannot set characters on a TextNode
 * without loading the font" se você pular isso, e `fontName` pode ser
 * `figma.mixed` quando várias fontes são usadas dentro de um mesmo nó de
 * texto.
 */
export async function setTextSafely(node: TextNode, characters: string): Promise<void> {
  if (node.fontName === figma.mixed) {
    throw new Error("Text node uses mixed fonts; set a single font first.");
  }

  await figma.loadFontAsync(node.fontName);
  node.characters = characters;
}

/**
 * A ordem importa quando você cria um filho de layout:
 *
 * 1. anexe primeiro: `layoutSizing*`, `layoutAlign` e `layoutGrow` só se
 *    aplicam a nós que já têm um pai;
 * 2. resize() antes de FILL/HUG, porque `resize()` redefine os dois modos de
 *    dimensionamento para `FIXED`, então chamá-lo por último desfaz
 *    silenciosamente o FILL que você acabou de definir;
 * 3. só então opte por FILL.
 */
export function appendFillingChild(parent: FrameNode, child: FrameNode): void {
  parent.appendChild(child);
  child.resize(120, 44);
  child.layoutSizingHorizontal = "FILL";
}

/**
 * Com `"documentAccess": "dynamic-page"` no manifest, páginas diferentes da
 * atual não são carregadas: `figma.root.children` fica incompleto e o
 * `figma.getNodeById` síncrono lança. Carregue o documento primeiro e depois
 * use `figma.getNodeByIdAsync(id)` (ou uma travessia como esta).
 */
export async function findLayerOnCurrentPage(name: string): Promise<SceneNode | null> {
  await figma.loadAllPagesAsync();

  const stack: SceneNode[] = [...figma.currentPage.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.name === name) {
      return node;
    }
    if (isContainer(node)) {
      stack.push(...node.children);
    }
  }

  return null;
}
