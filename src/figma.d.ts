/// <reference path="../node_modules/@figma/plugin-typings/plugin-api.d.ts" />

/**
 * Por que este arquivo existe em vez de `"types": ["@figma/plugin-typings"]`
 * no tsconfig.json:
 *
 * o `index.d.ts` do pacote redeclara `console`, `fetch`, `setTimeout` e
 * `setInterval` como globais. Eles colidem com a lib DOM do TypeScript
 * ("Cannot redeclare block-scoped variable 'console'"), e o bundle da UI
 * precisa da lib DOM por causa do React. Referenciar `plugin-api.d.ts`
 * diretamente traz todos os tipos do Figma (`SceneNode`, `PluginAPI`, ...)
 * sem tocar nos globais do DOM, e declaramos à mão os dois globais que o
 * runtime do plugin realmente injeta.
 */

declare const figma: PluginAPI;
declare const __html__: string;
