# figma-plugin-starter

A TypeScript + React 19 starter for Figma plugins. One esbuild script turns split
source into the two flat files Figma actually loads, and a typed message bus keeps
the sandbox and the iframe UI in sync.

The sample command renames the selection (or the children of selected containers:
frames, groups, components, sections) from a pattern like `{name} {n}`, with a case
transform and a live preview.

## Why this exists

Figma does not load a front-end project. It loads a manifest that points at:

- one JavaScript file, executed in a sandbox with no DOM and no module system, so
  everything, including dependencies, has to be bundled into a single IIFE;
- one HTML file for the UI iframe, served as a string, with no dev server and no
  separate CSS or JS requests.

That shape is fine, but wiring it by hand costs an afternoon every time: a build
that produces exactly those files, a UI bundle inlined into HTML, a `postMessage`
protocol that is typed on both sides, and the handful of Figma API behaviours that
fail silently when you get them wrong.

This repo is that wiring, plus one working command to copy.

## Quick start

```bash
npm install
npm run build
```

Then in Figma: **menu → Plugins → Development → Import plugin from manifest…** and
pick `dist/manifest.json`.

Figma resolves `main` and `ui` relative to the manifest file, so the build writes a
rebased copy into `dist/`, with `"main": "code.js"` and `"ui": "ui.html"`, next to the
artifacts themselves. The repository manifest keeps the `dist/` prefixes, so importing
that one works too; both point at the same two files.

Select a frame with a few children, run the plugin, and press Rename.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Builds `dist/code.js`, `dist/ui.html`, `dist/manifest.json` |
| `npm run watch` | Same, rebuilds on change and logs one line per output |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm test` | Vitest, plain Node, no Figma or DOM mocks |
| `npm run check` | typecheck + test + build |

## Dev loop

```bash
npm run watch
```

Edit anything under `src/`, and the bundle is rebuilt in a few milliseconds. Figma
caches the plugin files for a running instance, so a rebuild alone does not refresh
an open window: close the plugin window and run it again from
**Plugins → Development**. `manifest.json` is copied to `dist/` on change too, but
manifest edits only apply when the plugin is re-imported or Figma is restarted.

## Project structure

```text
.
├── manifest.json            # api 1.0.0, dynamic-page access, no network
├── scripts/
│   └── build.mjs            # both esbuild passes + HTML inlining
├── src/
│   ├── figma.d.ts           # Figma globals, without the DOM type clash
│   ├── main.ts              # sandbox: selection, rename, figma.notify
│   ├── core/
│   │   ├── rename.ts        # pure rename logic, no figma import
│   │   └── rename.test.ts
│   ├── shared/
│   │   ├── messages.ts      # message unions + typed send/subscribe helpers
│   │   └── messages.test.ts
│   └── ui/
│       ├── index.tsx        # React UI
│       └── styles.css       # inlined into dist/ui.html
├── tsconfig.json
└── vitest.config.ts
```

`src/core/` never imports `figma`, which is what lets the tests run in plain Node
and lets the UI reuse the exact same rename logic for its preview.

## How the build works

`scripts/build.mjs` runs esbuild twice, both with `write: false`, and each build has
an `onEnd` handler that writes the final artifact:

1. **Sandbox:** `src/main.ts` → `dist/code.js`, IIFE, `es2017`, unminified so it is
   readable in Figma's console.
2. **UI:** `src/ui/index.tsx` → a JS string plus a CSS string, inlined into a single
   `dist/ui.html`. No `<script src>` and no `<link>`: the manifest grants no network
   access, so nothing external could load anyway.

`manifest.json` is copied into `dist/` by the same pass, with `main` and `ui` rebased
to that directory, and watched separately in watch mode because no source file imports
it.

## How the messaging layer works

The two halves of a plugin are separate JS contexts. They share nothing at runtime,
so every interaction is a serialisable message. `postMessage` gives you `any` on
both ends; this repo puts a discriminated union in front of it:

```ts
// src/shared/messages.ts
export type UiToPluginMessage =
  | { type: "ready" }
  | { type: "rename"; pattern: string; transform: CaseTransform }
  | { type: "cancel" };

export type PluginToUiMessage =
  | { type: "selection"; selection: SelectionSummary }
  | { type: "renamed"; renamed: number; failures: RenameFailure[] }
  | { type: "error"; message: string };
```

Sandbox side:

```ts
import { onUiMessage, sendToUi } from "./shared/messages";

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
  }
});
```

UI side:

```tsx
import { onPluginMessage, sendToPlugin } from "../shared/messages";

useEffect(() => {
  const unsubscribe = onPluginMessage((message) => {
    if (message.type === "selection") setSelection(message.selection);
  });

  sendToPlugin({ type: "ready" });
  return unsubscribe;
}, []);
```

Three things make this hold together:

- `parseUiToPluginMessage` / `parsePluginToUiMessage` validate the payload once, at
  the boundary. Handlers only ever see well-formed messages, and unexpected ones are
  dropped instead of crashing the sandbox.
- Because the union is discriminated on `type`, a `switch` narrows the payload: add
  a variant and any handler that ignores it stops typechecking (`assertNever`).
- Each side imports only its own sender and subscriber, so the sandbox bundle never
  touches `window` and the UI bundle never touches `figma`.

## Adding a command

1. Add the request variant to `UiToPluginMessage` in `src/shared/messages.ts`, and the
   reply variant to `PluginToUiMessage`.
2. Teach `parseUiToPluginMessage` to accept the new request (validate its fields).
3. Handle it in the `switch` in `src/main.ts`. TypeScript will point at the switch
   until the new case exists.
4. Add the control to `src/ui/index.tsx` and send the message with `sendToPlugin`.
5. If the command has logic worth testing, put it in `src/core/` as a pure function
   and test it there.

## Pitfalls this starter handles

Each of these is commented at the place it matters in the source.

- **Fonts before text.** `node.characters = "..."` throws unless the font was loaded
  with `figma.loadFontAsync`, and `fontName` can be `figma.mixed`. See
  `setTextSafely` in `src/main.ts`.
- **`resize()` resets sizing modes.** It sets `layoutSizingHorizontal` and
  `layoutSizingVertical` back to `FIXED`, so calling it after `FILL` silently undoes
  the `FILL`.
- **`FILL` only applies to a node with a parent.** Append first, then set
  `layoutSizingHorizontal = "FILL"`. See `appendFillingChild`.
- **`figma.currentPage.selection` is readonly and untyped by layer kind.** `"children"
  in node` narrows `SceneNode` to the frame-like members; casting to `any` here is
  where plugins crash on text and vector layers. See `isContainer`.
- **Removed nodes.** A node can disappear between a message arriving and the write
  (undo, another plugin, a collaborator). `node.removed` is checked before each write.
- **`dynamic-page` access.** Other pages are not loaded: call
  `figma.loadAllPagesAsync()` and use `figma.getNodeByIdAsync`, not the synchronous
  `getNodeById`.
- **Exceptions in `figma.ui.onmessage` are swallowed.** A throwing handler looks like
  a dead button. `onUiMessage` catches and reports the error back to the UI.
- **Do not close the plugin after an action.** `figma.closePlugin()` runs once and the
  window is gone; renaming stays open, and only the explicit Close button closes it.
- **Theme.** `themeColors: true` in `figma.showUI` injects `--figma-color-*` variables;
  `styles.css` uses them with fallbacks, so the plugin follows light and dark mode.

## Tests

```bash
npm test
```

The suite covers pattern interpolation (`{name}`, 1-based `{n}`), missing-name
fallbacks, case transforms including accented Portuguese and multi-word titles,
pattern validation, collision suffixing, the five-entry preview cap, and the message
parsers. Everything runs against `src/core/` and `src/shared/`, both of which are
free of `figma` globals, so there is nothing to mock.

## Requirements

Node 20.11 or newer (the build uses `import.meta.dirname`) and npm. Figma desktop or
the web app.

## Author

[robertlogan.cc](https://robertlogan.cc)

## License

MIT. See [LICENSE](./LICENSE).
