import { getOwner } from '@ember/application';
import { registerDestructor } from '@ember/destroyable';
import Modifier from 'ember-modifier';
import type { AttacherArgs } from '../lib/attacher-core';
import {
  ControlledTooltipInstance,
  getTooltipPool,
  type SingletonTooltipPool,
} from '../lib/singleton-tooltip-pool';

export type TooltipModifierOptions = Omit<AttacherArgs, 'target'>;

export interface TooltipModifierSignature {
  Element: Element;
  Args: {
    Positional: [text: string | null | undefined];
    Named: TooltipModifierOptions;
  };
}

type TooltipBacking = SingletonTooltipPool | ControlledTooltipInstance;

function isControlledIsShown(named: TooltipModifierOptions): boolean {
  return named.isShown !== undefined;
}

/**
 * `{{tooltip "Text" class="..." ...}}` modifier for void and simple targets.
 *
 * Uncontrolled call sites share a single Top-Layer Attachment DOM node per
 * document via `SingletonTooltipPool` (#64). Controlled `isShown !== undefined`
 * call sites get a dedicated per-modifier `TooltipDomHost` + `AttacherCore`.
 */
export default class TooltipModifier extends Modifier<TooltipModifierSignature> {
  private _element: Element | null = null;
  private _backing: TooltipBacking | null = null;
  private _controlled = false;

  constructor(
    owner: ConstructorParameters<typeof Modifier<TooltipModifierSignature>>[0],
    args: ConstructorParameters<typeof Modifier<TooltipModifierSignature>>[1]
  ) {
    super(owner, args);
    registerDestructor(this, () => {
      if (this._backing && this._element) {
        this._backing.unregister(this._element);
      }
      this._element = null;
      this._backing = null;
    });
  }

  modify(
    element: Element,
    [text]: TooltipModifierSignature['Args']['Positional'],
    named: TooltipModifierSignature['Args']['Named']
  ): void {
    if (text == null || text === '') {
      if (this._backing && this._element) {
        this._backing.unregister(this._element);
        this._element = null;
        this._backing = null;
        this._controlled = false;
      }
      return;
    }

    const owner = getOwner(this);
    const controlled = isControlledIsShown(named);

    if (
      this._backing &&
      this._element &&
      (this._controlled !== controlled || (this._element !== element && this._controlled))
    ) {
      this._backing.unregister(this._element);
      this._backing = null;
      this._element = null;
    }

    if (this._element && this._element !== element && this._backing && !controlled) {
      this._backing.unregister(this._element);
    }

    let backing = this._backing;
    if (!backing) {
      if (controlled) {
        const doc = element.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!doc) {
          return;
        }
        backing = new ControlledTooltipInstance(doc, owner ?? null);
      } else {
        backing = getTooltipPool(element);
      }
      if (!backing) {
        return;
      }
      this._backing = backing;
      this._controlled = controlled;
    }

    this._element = element;
    backing.register(element, text, named as Record<string, unknown>, owner);
  }
}
