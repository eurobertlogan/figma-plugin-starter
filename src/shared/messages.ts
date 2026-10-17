/**
 * O protocolo UI <-> sandbox.
 *
 * O Figma entrega `postMessage` com `any` nos dois lados, então cada erro de
 * digitação no nome de uma mensagem ou no payload é um bug de runtime que só
 * aparece quando o usuário clica em algo. Este módulo resolve isso:
 *
 * - os dois tipos de mensagem são uniões discriminadas;
 * - cada lado ganha um remetente e um assinante, ambos totalmente tipados;
 * - os parsers validam o payload uma única vez, na fronteira, então o corpo
 *   dos handlers só vê mensagens bem formadas.
 *
 * O sandbox e a UI são contextos JS separados: os imports são empacotados
 * duas vezes e nada é compartilhado em runtime além dessas mensagens
 * serializáveis.
 */

import { isCaseTransform, type CaseTransform, type RenameFailure } from "../core/rename";

/** Quais nós a próxima renomeação vai atingir. */
export type RenameScope = "layer" | "children" | "mixed";

export interface SelectionSummary {
  /** Camadas de nível superior selecionadas no Figma. */
  selectedCount: number;
  /** Camadas que realmente seriam renomeadas (filhos, no caso de contêineres). */
  targetCount: number;
  scope: RenameScope;
  /** Nomes atuais dos alvos, na ordem em que o sandbox vai renomeá-los. */
  names: string[];
}

/** Sandbox -> UI. */
export type PluginToUiMessage =
  | { type: "selection"; selection: SelectionSummary }
  | { type: "renamed"; renamed: number; failures: RenameFailure[] }
  | { type: "error"; message: string };

/** UI -> sandbox. */
export type UiToPluginMessage =
  | { type: "ready" }
  | { type: "rename"; pattern: string; transform: CaseTransform }
  | { type: "cancel" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * Valida uma mensagem vinda da UI. Payloads desconhecidos ou malformados
 * retornam `null` e são descartados em vez de derrubar o sandbox. A própria
 * documentação do Figma recomenda tratar o iframe como entrada não confiável,
 * o que também mantém o switch abaixo tipado de forma exaustiva.
 */
export function parseUiToPluginMessage(value: unknown): UiToPluginMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "cancel":
      return { type: "cancel" };
    case "rename":
      if (typeof value.pattern !== "string" || !isCaseTransform(value.transform)) {
        return null;
      }
      return { type: "rename", pattern: value.pattern, transform: value.transform };
    default:
      return null;
  }
}

/** Valida uma mensagem vinda do sandbox. */
export function parsePluginToUiMessage(value: unknown): PluginToUiMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "selection": {
      const selection = value.selection;
      if (!isRecord(selection)) {
        return null;
      }

      const scope = selection.scope;
      if (scope !== "layer" && scope !== "children" && scope !== "mixed") {
        return null;
      }

      return {
        type: "selection",
        selection: {
          selectedCount: asCount(selection.selectedCount),
          targetCount: asCount(selection.targetCount),
          scope,
          names: Array.isArray(selection.names)
            ? selection.names.map(asString)
            : [],
        },
      };
    }
    case "renamed": {
      const failures = Array.isArray(value.failures) ? value.failures : [];
      return {
        type: "renamed",
        renamed: asCount(value.renamed),
        failures: failures.filter(isRecord).map((failure) => ({
          layer: asString(failure.layer),
          reason: asString(failure.reason),
        })),
      };
    }
    case "error":
      return { type: "error", message: asString(value.message) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Lado do sandbox
// ---------------------------------------------------------------------------

/** Envia uma mensagem tipada para o iframe. */
export function sendToUi(message: PluginToUiMessage): void {
  figma.ui.postMessage(message, { origin: "*" });
}

/**
 * Assina as mensagens da UI. Retorna uma função de cancelamento; chame-a em
 * `figma.on("close", ...)` para que um hot reload não deixe dois handlers
 * para trás.
 */
export function onUiMessage(handler: (message: UiToPluginMessage) => void): () => void {
  /**
   * Nota: exceções lançadas dentro de `figma.ui.onmessage` são engolidas pelo
   * runtime do plugin, o que faz um handler que quebra parecer um botão morto.
   * Capturar aqui e reportar de volta para a UI mantém as falhas visíveis.
   */
  const listener = (raw: unknown): void => {
    const message = parseUiToPluginMessage(raw);
    if (!message) {
      return;
    }

    try {
      handler(message);
    } catch (error) {
      sendToUi({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  figma.ui.onmessage = listener;

  return () => {
    if (figma.ui.onmessage === listener) {
      figma.ui.onmessage = undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Lado da UI
// ---------------------------------------------------------------------------

/** Envia uma mensagem tipada para o sandbox. */
export function sendToPlugin(message: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

/**
 * Assina as mensagens do sandbox. Retorna uma função de cancelamento para a
 * limpeza do efeito do React.
 */
export function onPluginMessage(handler: (message: PluginToUiMessage) => void): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isRecord(event.data)) {
      return;
    }

    const message = parsePluginToUiMessage(event.data.pluginMessage);
    if (message) {
      handler(message);
    }
  };

  window.addEventListener("message", listener);

  return () => {
    window.removeEventListener("message", listener);
  };
}

/**
 * Checagem de exaustividade em tempo de compilação para `switch` sobre
 * qualquer uma das uniões de mensagem: se uma nova variante for adicionada, o
 * branch default deixa de passar no typecheck até ser tratado.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
