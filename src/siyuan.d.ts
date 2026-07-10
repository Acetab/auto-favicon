/**
 * Minimal Plugin API surface used here. The current npm SDK declaration has
 * unrelated upstream errors, so this keeps local type checking deterministic.
 */
declare module "siyuan" {
  export class Setting {
    constructor(options: { confirmCallback?: () => void | Promise<void> });
    addItem(options: {
      title: string;
      description?: string;
      createActionElement: () => HTMLElement;
    }): void;
  }

  export class Plugin {
    setting?: Setting;
    loadData<T = any>(name: string): Promise<T>;
    saveData(name: string, data: unknown): Promise<void>;
  }

  export function showMessage(message: string): void;
}
