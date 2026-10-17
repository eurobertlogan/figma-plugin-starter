import { describe, expect, it } from "vitest";

import {
  PREVIEW_LIMIT,
  applyCase,
  interpolate,
  planRename,
  previewNames,
  validatePattern,
  type CaseTransform,
  type RenamePlan,
} from "./rename";

/** Wrapper de conveniência com `keep` como transformação padrão. */
function plan(
  names: readonly string[],
  pattern: string,
  transform: CaseTransform = "keep",
): RenamePlan {
  return planRename({ names, pattern, transform });
}

/** Extrai os nomes resultantes de um plano, falhando alto se ele for inválido. */
function names(plan0: RenamePlan): string[] {
  if (!plan0.ok) {
    throw new Error(`expected a valid plan, got: ${plan0.error}`);
  }

  return plan0.entries.map((entry) => entry.name);
}

describe("interpolate", () => {
  it("replaces {name} and 1-based {n}", () => {
    expect(interpolate("{name}: {n}", "Hero", 1)).toBe("Hero: 1");
    expect(interpolate("{name}: {n}", "Hero", 42)).toBe("Hero: 42");
  });

  it("replaces every occurrence of both tokens", () => {
    expect(interpolate("{n}. {name} ({name}) #{n}", "Card", 3)).toBe(
      "3. Card (Card) #3",
    );
  });

  it("treats $ sequences in layer names literally", () => {
    // String.replace expandiria `$&` e `$1` aqui; um replacer em função não.
    expect(interpolate("{name} $& $1", "Price $& $1", 1)).toBe("Price $& $1 $& $1");
  });

  it("leaves a pattern without tokens untouched", () => {
    expect(interpolate("Static", "Hero", 1)).toBe("Static");
  });
});

describe("planRename", () => {
  it("uses the 1-based index across the whole batch", () => {
    expect(names(plan(["A", "B", "C"], "Layer {n}"))).toEqual([
      "Layer 1",
      "Layer 2",
      "Layer 3",
    ]);
  });

  it("works without a {name} token", () => {
    expect(names(plan(["Hero", "Card"], "Section {n}"))).toEqual([
      "Section 1",
      "Section 2",
    ]);
  });

  it("falls back when the layer name is empty", () => {
    expect(names(plan([""], "{name}"))).toEqual(["Untitled layer"]);
    expect(names(plan(["   "], "{name} {n}"))).toEqual(["Untitled layer 1"]);
  });

  it("keeps the original name of every entry", () => {
    const result = plan(["Hero", "Card"], "{name} / {n}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.original)).toEqual(["Hero", "Card"]);
    }
  });

  it("trims the pattern before rendering", () => {
    expect(names(plan(["A"], "  {name}  "))).toEqual(["A"]);
  });
});

describe("applyCase", () => {
  it("keeps the value as typed", () => {
    expect(applyCase("Botão Primário", "keep")).toBe("Botão Primário");
  });

  it("uppercases accented Portuguese names", () => {
    expect(applyCase("Ação de cobrança", "upper")).toBe("AÇÃO DE COBRANÇA");
  });

  it("lowercases", () => {
    expect(applyCase("AÇÃO DE COBRANÇA", "lower")).toBe("ação de cobrança");
  });

  it("title-cases every word of a sentence", () => {
    expect(applyCase("relatório mensal de vendas", "title")).toBe(
      "Relatório Mensal De Vendas",
    );
  });

  it("title-cases accented names without breaking the accents", () => {
    expect(applyCase("josé da silva", "title")).toBe("José Da Silva");
    expect(applyCase("BOTÃO PRIMÁRIO", "title")).toBe("Botão Primário");
  });

  it("treats hyphens and slashes as word boundaries", () => {
    expect(applyCase("auto-layout do botão", "title")).toBe("Auto-Layout Do Botão");
    expect(applyCase("ícones/ação", "title")).toBe("Ícones/Ação");
  });

  it("leaves an empty string alone", () => {
    expect(applyCase("", "title")).toBe("");
  });
});

describe("validatePattern", () => {
  it("rejects empty and blank patterns", () => {
    expect(validatePattern("")).toMatch(/pattern/i);
    expect(validatePattern("   ")).toMatch(/pattern/i);
  });

  it("rejects unknown placeholders", () => {
    expect(validatePattern("{layer}")).toMatch(/\{layer\}/);
  });

  it("rejects an unbalanced brace", () => {
    expect(validatePattern("{name")).toMatch(/unbalanced/i);
  });

  it("rejects patterns that are too long", () => {
    expect(validatePattern("x".repeat(200))).toMatch(/too long/i);
  });

  it("accepts both tokens plus plain text", () => {
    expect(validatePattern("{name}: {n} (v2)")).toBeNull();
    expect(validatePattern("Static name")).toBeNull();
  });
});

describe("planRename collisions", () => {
  it("appends a numeric suffix when two layers would collide", () => {
    expect(names(plan(["A", "B", "C"], "Botão"))).toEqual([
      "Botão",
      "Botão 2",
      "Botão 3",
    ]);
  });

  it("does not add a suffix when the name is already free", () => {
    expect(names(plan(["Item", "Item 2"], "{name}"))).toEqual(["Item", "Item 2"]);
  });

  it("never emits duplicates", () => {
    const result = names(plan(["Card", "Card", "Card 2"], "{name}"));
    expect(new Set(result).size).toBe(result.length);
  });

  it("applies the case transform before choosing a suffix", () => {
    expect(names(plan(["a", "b"], "botão", "upper"))).toEqual(["BOTÃO", "BOTÃO 2"]);
  });
});

describe("planRename validation", () => {
  it("refuses an invalid pattern instead of guessing", () => {
    const result = plan(["A"], "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/pattern/i);
    }
  });

  it("returns an empty plan for an empty selection", () => {
    expect(names(plan([], "{name}"))).toEqual([]);
  });
});

describe("previewNames", () => {
  const eightLayers = ["A", "B", "C", "D", "E", "F", "G", "H"];

  it("caps the preview at five results", () => {
    const preview = previewNames({ names: eightLayers, pattern: "{name} {n}", transform: "keep" });
    expect(preview).toHaveLength(PREVIEW_LIMIT);
    expect(PREVIEW_LIMIT).toBe(5);
    expect(preview).toEqual(["A 1", "B 2", "C 3", "D 4", "E 5"]);
  });

  it("accepts a custom limit", () => {
    expect(
      previewNames({ names: eightLayers, pattern: "{name}", transform: "keep" }, 2),
    ).toEqual(["A", "B"]);
  });

  it("is empty when the pattern is invalid", () => {
    expect(previewNames({ names: eightLayers, pattern: "{nope}", transform: "keep" })).toEqual([]);
  });

  it("applies the case transform", () => {
    expect(
      previewNames({ names: ["ação"], pattern: "{name}", transform: "title" }),
    ).toEqual(["Ação"]);
  });
});
