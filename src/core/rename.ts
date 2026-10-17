/**
 * Lógica de renomeação pura.
 *
 * Deliberadamente livre de qualquer global `figma`: este módulo é importado
 * pelo sandbox (para renomear), pela UI (para o preview ao vivo) e pelos
 * testes. Isso só é possível porque nada aqui toca a API do Figma, o que
 * também significa que os testes rodam em Node puro, sem nenhum mock.
 */

/** Como o nome interpolado recebe a transformação de caixa. */
export const CASE_TRANSFORMS = ["keep", "upper", "lower", "title"] as const;

export type CaseTransform = (typeof CASE_TRANSFORMS)[number];

/** Placeholders suportados. `{n}` é baseado em 1. */
export const PATTERN_TOKENS = ["{name}", "{n}"] as const;

/** Trava de segurança para que um texto colado enorme não vire nome de camada. */
export const MAX_PATTERN_LENGTH = 120;

/** Quantas entradas a UI mostra no preview. */
export const PREVIEW_LIMIT = 5;

/** Usado quando o nome da camada está vazio ou só tem espaços. */
const FALLBACK_NAME = "Untitled layer";

export interface RenameFailure {
  /** Nome da camada no momento da tentativa. */
  layer: string;
  reason: string;
}

export interface RenameRequest {
  /** Nomes atuais das camadas alvo, na ordem da seleção. */
  names: readonly string[];
  pattern: string;
  transform: CaseTransform;
}

export interface RenameEntry {
  original: string;
  name: string;
}

/**
 * Um plano é ou uma lista de nomes a aplicar ou um erro de validação.
 * Modelá-lo como união discriminada impede que a UI renderize um preview
 * parcialmente válido.
 */
export type RenamePlan =
  | { ok: true; entries: RenameEntry[] }
  | { ok: false; error: string };

export function isCaseTransform(value: unknown): value is CaseTransform {
  return (
    typeof value === "string" &&
    (CASE_TRANSFORMS as readonly string[]).includes(value)
  );
}

/**
 * Retorna um erro legível por humanos, ou `null` quando o padrão é utilizável.
 */
export function validatePattern(pattern: string): string | null {
  if (pattern.trim() === "") {
    return 'Enter a pattern, for example "{name} {n}".';
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `Pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`;
  }

  // Remove os tokens conhecidos e depois procura por qualquer coisa que ainda
  // pareça um placeholder. Fazer assim mantém a checagem em um único lugar.
  const leftover = PATTERN_TOKENS.reduce(
    (rest, token) => rest.split(token).join(""),
    pattern,
  );

  const unknown = leftover.match(/\{[^{}]*\}/);
  if (unknown) {
    return `Unknown placeholder ${unknown[0]}. Use {name} or {n}.`;
  }

  if (leftover.includes("{")) {
    return "Unbalanced { in the pattern. Use {name} or {n}.";
  }

  return null;
}

/**
 * `title` capitaliza a primeira letra de cada palavra e passa o resto para
 * minúsculas. `.toLowerCase()` + `\p{L}` preserva os acentos do português
 * (AÇÃO -> Ação) em vez de corrompê-los com suposições somente ASCII.
 */
export function applyCase(value: string, transform: CaseTransform): string {
  switch (transform) {
    case "keep":
      return value;
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "title":
      return value
        .toLowerCase()
        .replace(/(^|[\s\-_/])(\p{L})/gu, (_match, separator: string, letter: string) => {
          return separator + letter.toUpperCase();
        });
  }
}

/**
 * Substitui `{name}` e `{n}`.
 *
 * Repare nos replacers em forma de função: com uma substituição por string,
 * `$&`, `$'` e similares dentro de um nome de camada seriam tratados como
 * padrões de substituição e corromperiam o resultado silenciosamente.
 */
export function interpolate(pattern: string, name: string, index: number): string {
  return pattern.replace(/\{(name|n)\}/g, (_match, token: string) =>
    token === "name" ? name : String(index),
  );
}

/** `"Button"` -> `"Button 2"`, depois `"Button 3"`, e assim por diante. */
function uniqueName(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) {
    return candidate;
  }

  let suffix = 2;
  while (taken.has(`${candidate} ${suffix}`)) {
    suffix += 1;
  }

  return `${candidate} ${suffix}`;
}

function displayName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? FALLBACK_NAME : trimmed;
}

/**
 * Converte os nomes atuais das camadas nos nomes que serão aplicados.
 *
 * A indexação percorre o lote inteiro (baseada em 1), na ordem da seleção,
 * para que `{n}` corresponda ao que o preview lista.
 */
export function planRename({ names, pattern, transform }: RenameRequest): RenamePlan {
  const error = validatePattern(pattern);
  if (error) {
    return { ok: false, error };
  }

  const template = pattern.trim();
  const taken = new Set<string>();
  const entries: RenameEntry[] = [];

  names.forEach((original, position) => {
    const index = position + 1;
    const interpolated = interpolate(template, displayName(original), index);
    const cased = applyCase(interpolated, transform).trim();
    const finalName = uniqueName(cased === "" ? `Layer ${index}` : cased, taken);

    taken.add(finalName);
    entries.push({ original, name: finalName });
  });

  return { ok: true, entries };
}

/**
 * Os primeiros `limit` nomes resultantes, para o preview. Retorna uma lista
 * vazia quando o padrão é inválido, então quem chama só precisa checar
 * `total`.
 */
export function previewNames(
  request: RenameRequest,
  limit: number = PREVIEW_LIMIT,
): string[] {
  const plan = planRename(request);
  if (!plan.ok) {
    return [];
  }

  return plan.entries.slice(0, Math.max(0, limit)).map((entry) => entry.name);
}
