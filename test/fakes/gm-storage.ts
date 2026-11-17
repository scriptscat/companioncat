import type { GmStorageApi } from "../../src/platform/storage";

type Listener = (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;

/**
 * In-memory GM value storage shared by several simulated tabs. Each tab() sees the same values;
 * a write from one tab fires listeners registered in that tab with remote=false and listeners of
 * every other tab with remote=true (what GM_addValueChangeListener does across tabs).
 */
export function createGmStorageFake() {
  const values = new Map<string, unknown>();
  const tabs: { listeners: Map<number, { key: string; cb: Listener }> }[] = [];
  let nextId = 1;

  function tab(): GmStorageApi {
    const me = { listeners: new Map<number, { key: string; cb: Listener }>() };
    tabs.push(me);
    const fire = (key: string, oldValue: unknown, newValue: unknown) => {
      for (const t of tabs) {
        for (const l of [...t.listeners.values()]) {
          if (l.key === key) l.cb(key, oldValue, newValue, t !== me);
        }
      }
    };
    return {
      GM_getValue: (key, def) => (values.has(key) ? structuredClone(values.get(key)) : def),
      GM_setValue: (key, value) => {
        const old = values.get(key);
        values.set(key, structuredClone(value));
        fire(key, old, value);
      },
      GM_deleteValue: (key) => {
        if (!values.has(key)) return;
        const old = values.get(key);
        values.delete(key);
        fire(key, old, undefined);
      },
      GM_listValues: () => [...values.keys()],
      GM_addValueChangeListener: (key, cb) => {
        const id = nextId++;
        me.listeners.set(id, { key, cb });
        return id;
      },
      GM_removeValueChangeListener: (id) => {
        me.listeners.delete(id as number);
      },
    };
  }

  return { tab, values };
}
