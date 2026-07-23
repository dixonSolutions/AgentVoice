import { Component, computed, effect, inject, signal } from '@angular/core';

import { Button } from '@openng/optimus-ui/button';

import { BridgeService } from '../../services/bridge.service';

/**
 * ImageCarouselComponent — full-screen carousel for agent-pushed UI screenshots.
 *
 * Auto-expands when show_images arrives, minimizes to a FAB after duration_ms,
 * and can be reopened any time until a new batch replaces it.
 */
@Component({
  selector: 'cv-image-carousel',
  standalone: true,
  imports: [Button],
  templateUrl: './image-carousel.component.html',
})
export class ImageCarouselComponent {
  protected readonly bridge = inject(BridgeService);

  protected readonly images = computed(() => this.bridge.carouselImages());
  protected readonly caption = computed(() => this.bridge.carouselCaption());
  protected readonly hasImages = computed(() => this.images().length > 0);

  /** Full overlay visible (false = minimized to FAB). */
  protected readonly expanded = signal(false);

  protected readonly activeIndex = signal(0);

  private minimizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const imgs = this.images();
      const duration = this.bridge.carouselDurationMs();

      if (this.minimizeTimer) {
        clearTimeout(this.minimizeTimer);
        this.minimizeTimer = null;
      }

      if (imgs.length === 0) {
        this.expanded.set(false);
        this.activeIndex.set(0);
        return;
      }

      this.activeIndex.set(0);
      this.expanded.set(true);

      this.minimizeTimer = setTimeout(() => {
        this.expanded.set(false);
        this.minimizeTimer = null;
      }, duration);
    });
  }

  protected minimize(): void {
    if (this.minimizeTimer) {
      clearTimeout(this.minimizeTimer);
      this.minimizeTimer = null;
    }
    this.expanded.set(false);
  }

  protected reopen(): void {
    this.expanded.set(true);
    const duration = this.bridge.carouselDurationMs();
    if (this.minimizeTimer) clearTimeout(this.minimizeTimer);
    this.minimizeTimer = setTimeout(() => {
      this.expanded.set(false);
      this.minimizeTimer = null;
    }, duration);
  }

  protected prev(): void {
    const len = this.images().length;
    if (len <= 1) return;
    this.activeIndex.update((i) => (i - 1 + len) % len);
  }

  protected next(): void {
    const len = this.images().length;
    if (len <= 1) return;
    this.activeIndex.update((i) => (i + 1) % len);
  }

  protected selectThumb(index: number): void {
    this.activeIndex.set(index);
  }
}
