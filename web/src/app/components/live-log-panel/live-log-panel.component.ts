import {
  Component,
  HostBinding,
  ViewChild,
  afterRenderEffect,
  computed,
  inject,
  signal,
  Input,
  type AfterViewInit,
  type ElementRef,
  type OnDestroy,
} from '@angular/core';

import { Button } from '@openng/optimus-ui/button';
import { Tag } from '@openng/optimus-ui/tag';

import type { LogEntry } from '../../services/log.service';
import { LogService } from '../../services/log.service';
import { ToastService } from '../../services/toast.service';
import { VoiceSessionService } from '../../services/voice-session.service';

const ITEM_HEIGHT_PX = 28;
const DEFAULT_VIEWPORT_HEIGHT_PX = 144;
const OVERSCAN = 3;
/** Within this distance of the bottom, treat scroll as "at bottom" and auto-follow new lines. */
const SCROLL_STICK_EPS_PX = 12;
const PANEL_HEIGHT_STORAGE_KEY = 'cv-live-log-panel-height-px';
const DEFAULT_PANEL_HEIGHT_PX = 144;
const MIN_PANEL_HEIGHT_PX = 112;
const MIN_VOICE_CONTROLS_HEIGHT_PX = 220;
const KEYBOARD_RESIZE_STEP_PX = 16;

function maximumPanelHeightPx(): number {
  if (typeof window === 'undefined') return 360;
  return Math.max(
    MIN_PANEL_HEIGHT_PX,
    window.innerHeight - MIN_VOICE_CONTROLS_HEIGHT_PX,
  );
}

function clampPanelHeight(heightPx: number): number {
  return Math.min(
    maximumPanelHeightPx(),
    Math.max(MIN_PANEL_HEIGHT_PX, Math.round(heightPx)),
  );
}

function readStoredPanelHeightPx(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_PANEL_HEIGHT_PX;
  const storedHeight = Number(localStorage.getItem(PANEL_HEIGHT_STORAGE_KEY));
  return Number.isFinite(storedHeight) && storedHeight > 0
    ? clampPanelHeight(storedHeight)
    : DEFAULT_PANEL_HEIGHT_PX;
}

@Component({
  selector: 'cv-live-log-panel',
  standalone: true,
  imports: [Button, Tag],
  templateUrl: './live-log-panel.component.html',
})
export class LiveLogPanelComponent implements AfterViewInit, OnDestroy {
  protected readonly logs = inject(LogService);
  protected readonly voiceSession = inject(VoiceSessionService);
  private readonly toast = inject(ToastService);

  @ViewChild('viewport') private viewport?: ElementRef<HTMLDivElement>;

  /** When false, the panel is not rendered (voice tab controls visibility). */
  @Input() visible = true;

  private readonly scrollTop = signal(0);
  private readonly stickToBottom = signal(true);
  private readonly viewportHeightPx = signal(DEFAULT_VIEWPORT_HEIGHT_PX);
  protected readonly panelHeightPx = signal(readStoredPanelHeightPx());
  protected readonly panelMinimumHeightPx = MIN_PANEL_HEIGHT_PX;
  protected readonly panelMaximumHeightPx = signal(maximumPanelHeightPx());
  private viewReady = false;
  private resizeObserver?: ResizeObserver;
  private resizeStartY = 0;
  private resizeStartHeightPx = DEFAULT_PANEL_HEIGHT_PX;

  @HostBinding('style.flex-basis.px')
  protected get preferredPanelHeightPx(): number {
    return this.panelHeightPx();
  }

  /** Voice + transcript only — bridge/system logs stay in the Logs tab. */
  protected readonly sessionEntries = computed(() =>
    this.logs.entries().filter(
      (entry) => entry.category === 'voice' || entry.category === 'transcript',
    ),
  );

  protected readonly virtualSlice = computed(() => {
    const entries = this.sessionEntries();
    const scroll = this.scrollTop();
    const viewportHeight = this.viewportHeightPx();
    const start = Math.max(0, Math.floor(scroll / ITEM_HEIGHT_PX) - OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / ITEM_HEIGHT_PX) + OVERSCAN * 2;
    const end = Math.min(entries.length, start + visibleCount);
    return {
      items: entries.slice(start, end),
      startIndex: start,
      totalHeight: entries.length * ITEM_HEIGHT_PX,
      offsetY: start * ITEM_HEIGHT_PX,
    };
  });

  constructor() {
    afterRenderEffect(() => {
      if (!this.viewReady || !this.visible) return;
      const entries = this.sessionEntries();
      if (entries.length === 0 || !this.stickToBottom()) return;
      // Depend on the latest line so every append triggers a post-render scroll.
      void entries[entries.length - 1]?.id;
      this.scrollToBottom();
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.observeViewport();
    this.scrollToBottom();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  private observeViewport(): void {
    const el = this.viewport?.nativeElement;
    if (!el) return;
    const sync = () => {
      const h = el.clientHeight;
      if (h > 0) this.viewportHeightPx.set(h);
    };
    sync();
    this.resizeObserver = new ResizeObserver(sync);
    this.resizeObserver.observe(el);
  }

  protected onScroll(event: Event): void {
    const el = event.target as HTMLElement;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    this.scrollTop.set(el.scrollTop);
    this.stickToBottom.set(el.scrollTop >= maxScroll - SCROLL_STICK_EPS_PX);
  }

  protected startPanelResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.refreshPanelMaximumHeight();
    this.resizeStartY = event.clientY;
    this.resizeStartHeightPx = this.panelHeightPx();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected resizePanel(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    if (!handle.hasPointerCapture(event.pointerId)) return;
    this.panelHeightPx.set(
      clampPanelHeight(this.resizeStartHeightPx + event.clientY - this.resizeStartY),
    );
  }

  protected finishPanelResize(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement;
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    this.persistPanelHeight();
  }

  protected resizePanelWithKeyboard(event: KeyboardEvent): void {
    const direction =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    this.refreshPanelMaximumHeight();
    const step = event.shiftKey
      ? KEYBOARD_RESIZE_STEP_PX * 2
      : KEYBOARD_RESIZE_STEP_PX;
    this.panelHeightPx.update((heightPx) =>
      clampPanelHeight(heightPx + direction * step),
    );
    this.persistPanelHeight();
  }

  protected clearLogs(): void {
    this.logs.clearVoiceSession();
    this.scrollTop.set(0);
    this.stickToBottom.set(true);
  }

  protected async copyAllLogs(): Promise<void> {
    const text = this.logs.formatSessionLogText(this.sessionEntries());
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied all logs', undefined, false);
    } catch {
      this.toast.error('Copy failed', 'Could not access clipboard.');
    }
  }

  protected exportLogsJson(): void {
    const entries = this.sessionEntries();
    if (entries.length === 0) return;
    const blob = new Blob([this.logs.exportSessionLogJson(entries)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cursor-voice-session-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.toast.success('Exported JSON', undefined, false);
  }

  protected formatTime(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  protected categoryLabel(entry: LogEntry): string {
    return entry.subcategory ?? entry.category;
  }

  protected async copyEntry(entry: LogEntry, event: Event): Promise<void> {
    event.stopPropagation();
    const text = this.logs.formatEntryLine(entry);
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success('Copied', undefined, false);
    } catch {
      this.toast.error('Copy failed', 'Could not access clipboard.');
    }
  }

  protected trackEntry(_index: number, entry: LogEntry): number {
    return entry.id;
  }

  private scrollToBottom(): void {
    const el = this.viewport?.nativeElement;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = maxScroll;
    this.scrollTop.set(el.scrollTop);
  }

  private refreshPanelMaximumHeight(): void {
    this.panelMaximumHeightPx.set(maximumPanelHeightPx());
    this.panelHeightPx.update(clampPanelHeight);
  }

  private persistPanelHeight(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        PANEL_HEIGHT_STORAGE_KEY,
        String(this.panelHeightPx()),
      );
    }
  }
}
