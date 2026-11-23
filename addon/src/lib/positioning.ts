import {
  arrow,
  flip,
  limitShift,
  offset,
  platform as floatingPlatform,
  shift,
  type ComputePositionConfig,
  type Middleware,
  type MiddlewareData,
  type OffsetOptions,
  type Placement,
  type Platform,
  type Strategy,
} from '@floating-ui/dom';
import { isElementTarget, type AttachmentTarget } from './target-resolution';

const DEFAULT_SHIFT_PADDING = 5;

/** Check whether an attachment target (DOM Element or VirtualElement) is still connected. */
export function isTargetConnected(target: AttachmentTarget | null | undefined): boolean {
  if (!target) {
    return false;
  }

  if (isElementTarget(target)) {
    return target.isConnected;
  }

  if (target.contextElement instanceof Element) {
    return target.contextElement.isConnected;
  }

  return true;
}

export interface BuildMiddlewareOptions {
  rawMiddleware?: ComputePositionConfig['middleware'] | null;
  arrowElement: Element | null;
  arrowEnabled: boolean;
  /** Shorthand Floating UI `offset()` options. Skipped when middleware already includes `offset`. */
  offsetOptions?: OffsetOptions | null;
}

/**
 * Normalize and deduplicate the Floating UI middleware array without mutating
 * caller-supplied middleware objects. Prepends `offset(...)` from `@offset` /
 * ENV when no existing `offset` middleware is present.
 */
export function buildMiddleware({
  rawMiddleware,
  arrowElement,
  arrowEnabled,
  offsetOptions = null,
}: BuildMiddlewareOptions): Middleware[] {
  const middleware: Middleware[] = [];

  for (const m of rawMiddleware || []) {
    if (!m) {
      continue;
    }

    if (m.name === 'arrow' && arrowElement) {
      if (typeof m.options === 'function') {
        const optionsFn = m.options;
        middleware.push(
          arrow((state) => {
            const resolved = optionsFn(state) || {};
            return resolved.element ? resolved : { ...resolved, element: arrowElement };
          })
        );
        continue;
      }
      if (!(m.options as { element?: Element } | undefined)?.element) {
        middleware.push(
          arrow({ ...(m.options as Record<string, unknown> | undefined), element: arrowElement })
        );
        continue;
      }
    }

    middleware.push(m);
  }

  if (offsetOptions != null && !middleware.some((m) => m.name === 'offset')) {
    middleware.unshift(offset(offsetOptions));
  }

  if (!middleware.some((m) => m.name === 'flip')) {
    middleware.push(flip());
  }

  if (!middleware.some((m) => m.name === 'shift')) {
    middleware.push(shift({ limiter: limitShift(), padding: DEFAULT_SHIFT_PADDING }));
  }

  if (arrowEnabled && arrowElement && !middleware.some((m) => m.name === 'arrow')) {
    middleware.push(arrow({ element: arrowElement }));
  }

  return middleware;
}

/** True when the middleware pipeline includes Floating UI `offset`. */
export function middlewareHasOffset(middleware: Middleware[] | null | undefined): boolean {
  return Boolean(middleware?.some((m) => m.name === 'offset'));
}

function isOpenTopLayerHost(element: Element): boolean {
  try {
    if (element.matches(':popover-open')) {
      return true;
    }
  } catch {
    // Older engines may not support :popover-open.
  }
  try {
    return element.matches(':modal');
  } catch {
    return false;
  }
}

/** Walk ancestors of `node` and return the nearest open Top-Layer Host, if any. */
export function findOpenTopLayerAncestor(node: Element | null | undefined): Element | null {
  if (!node || typeof node.closest !== 'function') {
    return null;
  }

  let current: Element | null = node;
  while (current) {
    if (isOpenTopLayerHost(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isOverflowClippingElement(element: Element): boolean {
  if (typeof getComputedStyle !== 'function') {
    return false;
  }
  const style = getComputedStyle(element);
  const overflow = style.overflow + style.overflowY + style.overflowX;
  return (
    /auto|scroll|overlay|hidden|clip/.test(overflow) &&
    style.display !== 'inline' &&
    style.display !== 'contents'
  );
}

/**
 * Collect overflow clipping ancestors of `element` that lie inside `topLayerHost`
 * (inclusive), stopping at that Top-Layer boundary.
 */
export function getOverflowAncestorsInsideTopLayer(
  element: Element,
  topLayerHost: Element
): Element[] {
  const ancestors: Element[] = [];
  let current: Element | null = element.parentElement;

  while (current) {
    if (isOverflowClippingElement(current)) {
      ancestors.push(current);
    }
    if (current === topLayerHost) {
      break;
    }
    current = current.parentElement;
  }

  if (!ancestors.includes(topLayerHost)) {
    ancestors.push(topLayerHost);
  }

  return ancestors;
}

/**
 * Build a Floating UI `platform` that, when `boundary === 'clippingAncestors'` and
 * `reference` sits inside an open Top-Layer Host, preserves overflow ancestors inside
 * that host and stops at the Top-Layer boundary (fixing hide/flip/shift/size inside
 * `<dialog>` and nested popovers).
 */
export function createTopLayerAwarePlatform(reference: AttachmentTarget | null): Platform {
  const referenceEl = isElementTarget(reference)
    ? reference
    : reference && 'contextElement' in reference && isElementTarget(reference.contextElement)
      ? reference.contextElement
      : null;
  const topLayerHost = findOpenTopLayerAncestor(referenceEl);

  if (!topLayerHost) {
    return floatingPlatform;
  }

  return {
    ...floatingPlatform,
    getClippingRect(args) {
      if (args.boundary !== 'clippingAncestors') {
        return floatingPlatform.getClippingRect.call(this, args);
      }

      const clippedElement = args.element;
      const ancestors = getOverflowAncestorsInsideTopLayer(clippedElement, topLayerHost);
      return floatingPlatform.getClippingRect.call(this, {
        ...args,
        boundary: ancestors,
      });
    },
  };
}

export interface ApplyPositionResultOptions {
  x: number;
  y: number;
  placement: Placement;
  strategy: Strategy;
  middlewareData: MiddlewareData;
  isHidden: boolean;
}

/**
 * Apply the resolved `computePosition` coordinates, arrow offset, `middlewareData.hide`
 * attributes, `data-placement`, and `x-placement` to the floating and arrow elements.
 */
export function applyPositionResult(
  floatingElement: HTMLElement,
  arrowElement: HTMLElement | null,
  { x, y, placement, strategy, middlewareData, isHidden }: ApplyPositionResultOptions
): void {
  Object.assign(floatingElement.style, {
    position: strategy,
    left: `${x}px`,
    top: `${y}px`,
  });

  if (middlewareData.arrow && arrowElement) {
    const { x: arrowX, y: arrowY } = middlewareData.arrow;
    Object.assign(arrowElement.style, {
      left: arrowX != null ? `${arrowX}px` : '',
      top: arrowY != null ? `${arrowY}px` : '',
    });
  }

  let hiddenByMiddleware = false;
  if (middlewareData.hide) {
    const { referenceHidden, escaped } = middlewareData.hide;
    hiddenByMiddleware = Boolean(referenceHidden || escaped);

    if (referenceHidden) {
      floatingElement.setAttribute('data-reference-hidden', '');
    } else {
      floatingElement.removeAttribute('data-reference-hidden');
    }

    if (escaped) {
      floatingElement.setAttribute('data-escaped', '');
    } else {
      floatingElement.removeAttribute('data-escaped');
    }
  } else {
    floatingElement.removeAttribute('data-reference-hidden');
    floatingElement.removeAttribute('data-escaped');
  }

  if (hiddenByMiddleware) {
    floatingElement.style.visibility = 'hidden';
  } else if (!isHidden) {
    floatingElement.style.visibility = '';
  }

  floatingElement.setAttribute('data-placement', placement);
  floatingElement.setAttribute('x-placement', placement);
}
