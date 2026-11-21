import { hasPageTranslationMarker } from "./browser-error-context";

/**
 * Browser page translation (Chrome and Google Translate) rewrites text in
 * place. It replaces a text node, or moves it into a `<font>` wrapper. React
 * still holds the original node. On the next commit that removes the node or
 * inserts before it, React calls `removeChild` or `insertBefore` on the old
 * parent. The DOM then throws `NotFoundError`, and the route error boundary
 * replaces the page. React does not support this case (facebook/react#11538).
 *
 * This guard handles only that shape. The page must have the translation
 * marker class, and the node must be detached or still inside the parent. In
 * that case the guard does what React asked for. In every other case it calls
 * the native method, so real DOM bugs still throw and reach the error monitor.
 */

interface GuardedMethods {
  removeChild: Node["removeChild"];
  insertBefore: Node["insertBefore"];
}

let installed: GuardedMethods | undefined;

/** The ancestor of `node` that is a direct child of `parent`. */
function childOfParentContaining(parent: Node, node: Node): Node | null {
  let current: Node | null = node;
  while (current && current.parentNode !== parent) current = current.parentNode;
  return current;
}

/**
 * Install the guard on `Node.prototype`. Call it before React first renders.
 * Only the first call installs. Its return value restores the native methods;
 * later calls return a no-op.
 */
export function startTranslationDomGuard(): () => void {
  if (installed || typeof Node !== "function" || !Node.prototype) return () => {};
  const proto = Node.prototype;
  const native: GuardedMethods = { removeChild: proto.removeChild, insertBefore: proto.insertBefore };
  installed = native;

  proto.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child && child.parentNode !== this && hasPageTranslationMarker()) {
      // Translation already detached it: the node is gone, as React asked.
      if (child.parentNode === null) return child;
      // Translation moved it into a wrapper inside this parent: remove it there.
      if (this.contains(child)) return native.removeChild.call(child.parentNode, child) as T;
    }
    return native.removeChild.call(this, child) as T;
  };

  proto.insertBefore = function insertBefore<T extends Node>(this: Node, node: T, child: Node | null): T {
    if (child && child.parentNode !== this && hasPageTranslationMarker()) {
      // Translation detached the reference node: keep the new content visible.
      if (child.parentNode === null) return native.insertBefore.call(this, node, null) as T;
      // Translation moved it into a wrapper: insert before that wrapper.
      const wrapper = this.contains(child) ? childOfParentContaining(this, child) : null;
      if (wrapper) return native.insertBefore.call(this, node, wrapper) as T;
    }
    return native.insertBefore.call(this, node, child) as T;
  };

  return () => {
    if (installed !== native) return;
    proto.removeChild = native.removeChild;
    proto.insertBefore = native.insertBefore;
    installed = undefined;
  };
}
