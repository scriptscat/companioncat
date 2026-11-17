/**
 * Build-time stand-in for `react-style-singleton` (aliased in vite.config.ts). Radix's scroll lock
 * (react-remove-scroll, used by Select and DropdownMenu) would otherwise append a <style> to the
 * page's document.head while a popup is open — CSS that changes the page, against R1.2, and that
 * a strict CSP blocks anyway (R13.1). The wheel/touch blocking of the scroll lock is unaffected.
 */
export const styleSingleton = () => () => null;
export const styleHookSingleton = () => (_styles: string, _dynamic?: boolean) => {};
export const stylesheetSingleton = () => ({ add: (_style: string) => {}, remove: () => {} });
