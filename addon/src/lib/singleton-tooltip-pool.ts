import type Owner from '@ember/owner';
import AttacherCore, {
  resolveTooltipClass,
  type AttacherArgs,
  type HostRenderState,
} from './attacher-core';
import { cancelScheduled, scheduleMicrotask, type ScheduledHandle } from './schedule';

const poolsByDocument = new WeakMap<Document, SingletonTooltipPool>();
const BASE_ARGS: AttacherArgs = Object.freeze({ ariaRole: 'tooltip' });

type HostMountCallback = (floatingEl: HTMLElement, arrowEl: HTMLElement | null) => void;

/**
 * Imperative DOM host rendering tooltip Attachment markup from read-only
 * `AttacherCore` render snapshots. Shared by the document-wide singleton pool
 * and per-modifier controlled `isShown` hosts.
 */
export class TooltipDomHost {
  doc: Document;
  hostEl: HTMLDivElement | null = null;
  innerEl: HTMLDivElement | null = null;
  contentEl: HTMLSpanElement | null = null;
  arrowEl: HTMLDivElement | null = null;
  fillEl: HTMLDivElement | null = null;

  constructor(doc: Document) {
    this.doc = doc;
  }

  _createElements(): void {
    const host = this.doc.createElement('div');
    host.className = 'ember-attacher';
    host.setAttribute('aria-hidden', 'true');

    const inner = this.doc.createElement('div');
    const content = this.doc.createElement('span');
    content.className = 'ember-attacher-tooltip-content';

    const arrow = this.doc.createElement('div');
    arrow.className = 'ember-attacher-arrow';

    const fill = this.doc.createElement('div');
    fill.className = 'ember-attacher-fill-backdrop';
    fill.setAttribute('aria-hidden', 'true');
    const circle = this.doc.createElement('div');
    circle.className = 'ember-attacher-fill-circle';
    fill.appendChild(circle);

    inner.appendChild(content);
    host.appendChild(inner);

    this.hostEl = host;
    this.innerEl = inner;
    this.contentEl = content;
    this.arrowEl = arrow;
    this.fillEl = fill;
  }

  sync(state: HostRenderState, onHostMounted: HostMountCallback): void {
    if (!state.activeElement || (!state.hasContent && !this.hostEl)) {
      return;
    }

    if (!this.hostEl) {
      this._createElements();
    }

    const hostEl = this.hostEl!;
    const innerEl = this.innerEl!;
    const contentEl = this.contentEl!;
    const arrowEl = this.arrowEl!;
    const fillEl = this.fillEl!;

    const container = state.container || this.doc.body;
    if (container && hostEl.parentNode !== container) {
      container.appendChild(hostEl);
    }

    onHostMounted(hostEl, state.arrow ? arrowEl : null);

    if (state.id && hostEl.id !== state.id) {
      hostEl.id = state.id;
    }

    if (state.role && hostEl.getAttribute('role') !== state.role) {
      hostEl.setAttribute('role', state.role);
    }

    if (state.popoverAttr === 'manual') {
      if (hostEl.getAttribute('popover') !== 'manual') {
        hostEl.setAttribute('popover', 'manual');
      }
    } else if (hostEl.hasAttribute('popover')) {
      hostEl.removeAttribute('popover');
    }

    const nextText = state.text ?? '';
    if (state.hasContent || !state.isHiding) {
      if (contentEl.textContent !== nextText) {
        contentEl.textContent = nextText;
      }
    }

    const nextClass = state.className ?? '';
    if (innerEl.className !== nextClass) {
      innerEl.className = nextClass;
    }

    if (state.arrow) {
      if (arrowEl.parentNode !== innerEl) {
        innerEl.appendChild(arrowEl);
      }
    } else if (arrowEl.parentNode === innerEl) {
      innerEl.removeChild(arrowEl);
    }

    if (state.isFillAnimation) {
      if (fillEl.parentNode !== innerEl) {
        innerEl.appendChild(fillEl);
      }
    } else if (fillEl.parentNode === innerEl) {
      innerEl.removeChild(fillEl);
    }
  }

  destroy(): void {
    if (this.hostEl?.parentNode) {
      this.hostEl.parentNode.removeChild(this.hostEl);
    }
    this.hostEl = null;
    this.innerEl = null;
    this.contentEl = null;
    this.arrowEl = null;
    this.fillEl = null;
  }
}

function createTooltipCore(
  host: TooltipDomHost,
  ownerContext: object | null
): AttacherCore {
  const holder: { core?: AttacherCore } = {};
  holder.core = new AttacherCore(ownerContext, () => BASE_ARGS, {
    defaultConfigKey: 'tooltip',
    defaultAriaRole: 'tooltip',
    isComponentHost: false,
    getDefaultClass: () => resolveTooltipClass(holder.core?.envConfig),
    onRenderStateChange: (state) =>
      host.sync(state, (floatingEl, arrowEl) =>
        holder.core?.setHostElements(floatingEl, arrowEl)
      ),
  });
  return holder.core;
}

/**
 * Dedicated per-modifier Host + Core for controlled `{{tooltip ... isShown=...}}`
 * so controlled visibility never contends with the document-wide singleton pool.
 */
export class ControlledTooltipInstance {
  host: TooltipDomHost;
  core: AttacherCore;
  private _visibilitySyncHandle: ScheduledHandle | null = null;
  private _element: Element | null = null;

  constructor(doc: Document, ownerContext: object | null = null) {
    this.host = new TooltipDomHost(doc);
    this.core = createTooltipCore(this.host, ownerContext);
  }

  register(
    element: Element,
    text: string,
    namedOptions: Record<string, unknown> | null | undefined,
    owner: Owner | null | undefined
  ): void {
    if (!this.core || this.core.isDestroyed) {
      return;
    }

    if (this._element && this._element !== element) {
      this.core.unregisterTargetElement(this._element);
    }
    this._element = element;

    const normalizedOptions =
      namedOptions && typeof namedOptions === 'object' ? (namedOptions as AttacherArgs) : null;

    this.core.registerTargetElement(element, text, normalizedOptions, owner ?? null);

    if (this._visibilitySyncHandle) {
      cancelScheduled(this._visibilitySyncHandle);
      this._visibilitySyncHandle = null;
    }

    const controlledIsShown = normalizedOptions?.isShown;
    if (controlledIsShown !== true && controlledIsShown !== false) {
      return;
    }

    this._visibilitySyncHandle = scheduleMicrotask(() => {
      this._visibilitySyncHandle = null;
      if (!this.core || this.core.isDestroyed) {
        return;
      }

      const isActive = this.core.isActiveTarget(element);
      const isOpen = this.core.liveIsShown || !this.core.isHidden;

      if (controlledIsShown === true && (!isActive || !this.core.liveIsShown)) {
        this.core.show(element, text);
      } else if (controlledIsShown === false && isActive && isOpen) {
        this.core.hide();
      }
    });
  }

  unregister(element: Element): void {
    if (this._visibilitySyncHandle) {
      cancelScheduled(this._visibilitySyncHandle);
      this._visibilitySyncHandle = null;
    }

    this.core?.unregisterTargetElement(element);
    if (this._element === element) {
      this._element = null;
    }
    this.destroy();
  }

  destroy(): void {
    if (this._visibilitySyncHandle) {
      cancelScheduled(this._visibilitySyncHandle);
      this._visibilitySyncHandle = null;
    }
    this.core?.destroy();
    this.core = null as unknown as AttacherCore;
    this.host?.destroy();
    this.host = null as unknown as TooltipDomHost;
    this._element = null;
  }
}

export class SingletonTooltipPool {
  doc: Document | null;
  host: TooltipDomHost | null;
  core: AttacherCore | null;
  private _visibilitySyncHandles = new Map<Element, ScheduledHandle>();

  constructor(doc: Document) {
    this.doc = doc;
    this.host = new TooltipDomHost(doc);
    this.core = createTooltipCore(this.host, null);
  }

  register(
    element: Element,
    text: string,
    namedOptions: Record<string, unknown> | null | undefined,
    owner: Owner | null | undefined
  ): void {
    if (!this.core || this.core.isDestroyed) {
      return;
    }

    const normalizedOptions =
      namedOptions && typeof namedOptions === 'object' ? (namedOptions as AttacherArgs) : null;

    this.core.registerTargetElement(element, text, normalizedOptions, owner ?? null);

    const prevHandle = this._visibilitySyncHandles.get(element);
    if (prevHandle) {
      cancelScheduled(prevHandle);
      this._visibilitySyncHandles.delete(element);
    }

    const controlledIsShown = normalizedOptions?.isShown;
    if (controlledIsShown !== true && controlledIsShown !== false) {
      return;
    }

    // Defer tracked visibility transitions out of Modifier.modify()'s tracking frame.
    const handle = scheduleMicrotask(() => {
      this._visibilitySyncHandles.delete(element);
      if (!this.core || this.core.isDestroyed) {
        return;
      }

      const isActive = this.core.isActiveTarget(element);
      const isOpen = this.core.liveIsShown || !this.core.isHidden;

      if (controlledIsShown === true && (!isActive || !this.core.liveIsShown)) {
        this.core.show(element, text);
      } else if (controlledIsShown === false && isActive && isOpen) {
        this.core.hide();
      }
    });
    this._visibilitySyncHandles.set(element, handle);
  }

  unregister(element: Element): void {
    const handle = this._visibilitySyncHandles.get(element);
    if (handle) {
      cancelScheduled(handle);
      this._visibilitySyncHandles.delete(element);
    }

    this.core?.unregisterTargetElement(element);

    if (!this.core || this.core.entryCount === 0) {
      this.destroy();
    }
  }

  destroy(): void {
    for (const handle of this._visibilitySyncHandles.values()) {
      cancelScheduled(handle);
    }
    this._visibilitySyncHandles.clear();

    if (this.doc) {
      poolsByDocument.delete(this.doc);
    }
    this.core?.destroy();
    this.core = null;
    this.host?.destroy();
    this.host = null;
  }
}

/** Get or create the document-scoped singleton tooltip pool. */
export function getTooltipPool(element: Element): SingletonTooltipPool | null {
  const doc =
    element?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) {
    return null;
  }

  let pool = poolsByDocument.get(doc);
  if (!pool) {
    pool = new SingletonTooltipPool(doc);
    poolsByDocument.set(doc, pool);
  }
  return pool;
}
