import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

const NOOP_THEME = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
  strikethrough: (t: string) => t,
};

export function createNoopUiContext(
  overrides?: Partial<ExtensionUIContext>,
): ExtensionUIContext {
  const base: Record<string, unknown> = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    setEditorComponent: () => {},
    theme: NOOP_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Not supported in headless mode" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        base[key] = value;
      }
    }
  }

  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => {};
    },
  }) as unknown as ExtensionUIContext;
}
