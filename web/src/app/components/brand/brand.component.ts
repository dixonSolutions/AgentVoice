import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { APP_ICON_SRC, APP_NAME } from '../../branding';

/**
 * The app's identity: mark, and optionally the wordmark beside it.
 *
 * One component so "AgentVoice" is rendered from `branding.ts` in every place
 * it appears. It replaces the old brand-logo + separate `<p-tag value="AgentVoice">`
 * pairing, which drew the name twice in the top bar and again in the token
 * dialog from three different string literals.
 */
@Component({
  selector: 'cv-brand',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img
      class="cv-brand-mark"
      [class]="'cv-brand-mark--' + size()"
      [src]="iconSrc"
      [attr.width]="dimension()"
      [attr.height]="dimension()"
      alt=""
      aria-hidden="true" />
    @if (wordmark()) {
      <span class="cv-brand-name">{{ appName }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }

    .cv-brand-mark {
      display: block;
      border-radius: 0.45rem;
      object-fit: contain;
    }

    .cv-brand-mark--sm {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.4rem;
    }

    .cv-brand-mark--md {
      width: 2rem;
      height: 2rem;
    }

    .cv-brand-mark--lg {
      width: 3rem;
      height: 3rem;
      border-radius: 0.65rem;
    }

    .cv-brand-name {
      font-weight: 600;
      letter-spacing: -0.01em;
      white-space: nowrap;
      color: var(--p-text-color);
    }

    :host(.cv-brand--lg) .cv-brand-name {
      font-size: 1.125rem;
    }
  `,
  host: {
    '[class.cv-brand--lg]': "size() === 'lg'",
  },
})
export class BrandComponent {
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  /** Draw the app name next to the mark. Off by default — most places want the mark alone. */
  readonly wordmark = input(false);

  protected readonly appName = APP_NAME;
  protected readonly iconSrc = APP_ICON_SRC;

  protected readonly dimension = computed(() => {
    switch (this.size()) {
      case 'sm':
        return 28;
      case 'lg':
        return 48;
      default:
        return 32;
    }
  });
}
