import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';

export interface BrowserTestEnvironment {
  container: HTMLElement;
  window: Window & typeof globalThis;
  runInterval(delay: number): void;
  restore(): void;
}

export function installBrowserEnvironment(): BrowserTestEnvironment {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://openapp.test/',
  });
  // React 在 JSDOM 安装前加载时会走旧输入事件兼容分支；补齐其监听钩子以保持受控输入测试有效。
  const legacyEventPrototype = dom.window.HTMLElement.prototype as typeof dom.window.HTMLElement.prototype & {
    attachEvent?: (name: string, listener: EventListener) => void;
    detachEvent?: (name: string, listener: EventListener) => void;
  };
  legacyEventPrototype.attachEvent = function attachEvent(name, listener) {
    this.addEventListener(name.replace(/^on/u, ''), listener);
  };
  legacyEventPrototype.detachEvent = function detachEvent(name, listener) {
    this.removeEventListener(name.replace(/^on/u, ''), listener);
  };
  let intervalSequence = 0;
  const intervals = new Map<number, { delay: number; handler: () => void }>();
  dom.window.setInterval = ((handler: TimerHandler, delay = 0) => {
    const id = ++intervalSequence;
    if (typeof handler !== 'function') throw new Error('string timers are not supported in UI tests');
    intervals.set(id, { delay, handler: () => handler() });
    return id;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = ((id: number) => {
    intervals.delete(id);
  }) as typeof dom.window.clearInterval;
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'SVGElement',
    'Node',
    'Event',
    'MouseEvent',
    'DOMException',
    'EventSource',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

  class TestEventSource {
    onerror: ((event: Event) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  }

  const values: Record<(typeof keys)[number], unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    DOMException: dom.window.DOMException,
    EventSource: TestEventSource,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of keys) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
  const container = dom.window.document.getElementById('root');
  assert.ok(container instanceof dom.window.HTMLElement);
  return {
    container,
    window: dom.window as unknown as Window & typeof globalThis,
    runInterval(delay) {
      for (const interval of intervals.values()) {
        if (interval.delay === delay) interval.handler();
      }
    },
    restore() {
      dom.window.close();
      for (const key of keys) {
        const descriptor = descriptors.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

export async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  throw failure;
}

export function requireElement<T extends Element>(container: Element, selector: string): T {
  const element = container.querySelector<T>(selector);
  assert.ok(element, `missing element: ${selector}`);
  return element;
}

export function buttonWithText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(button instanceof window.HTMLButtonElement, `missing button: ${text}`);
  return button;
}

export function rowWithText(container: Element, text: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll('tr')].find((candidate) => (
    [...candidate.cells].some((cell) => cell.textContent?.trim() === text)
  ));
  assert.ok(row instanceof window.HTMLTableRowElement, `missing row: ${text}`);
  return row;
}

export async function clickRowAction(container: Element, instanceId: string, label: string): Promise<void> {
  const row = rowWithText(container, instanceId);
  const button = row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `missing ${label} action for ${instanceId}`);
  await act(async () => button.click());
}
