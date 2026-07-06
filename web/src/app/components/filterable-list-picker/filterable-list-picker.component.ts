import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { InputText } from 'primeng/inputtext';

export interface FilterableListOption {
  value: string;
  title: string;
  detail?: string;
  search: string;
}

@Component({
  selector: 'cv-filterable-list-picker',
  standalone: true,
  imports: [FormsModule, InputText],
  template: `
    <div class="cv-filterable-picker" [class.cv-filterable-picker--disabled]="disabled()">
      <input
        pInputText
        class="cv-filterable-picker__filter"
        [id]="inputId()"
        [placeholder]="filterPlaceholder()"
        [(ngModel)]="filterText"
        [disabled]="disabled()"
        autocomplete="off"
        spellcheck="false" />

      <div
        class="cv-filterable-picker__list"
        role="listbox"
        [attr.aria-label]="ariaLabel()"
        [style.max-height]="maxHeight()">
        @for (option of filteredOptions(); track option.value) {
          <button
            type="button"
            class="cv-filterable-picker__item"
            role="option"
            [attr.aria-selected]="option.value === value()"
            [class.cv-filterable-picker__item--selected]="option.value === value()"
            [disabled]="disabled()"
            (click)="select(option.value)">
            <span class="cv-filterable-picker__title">{{ option.title }}</span>
            @if (option.detail) {
              <span class="cv-filterable-picker__detail">{{ option.detail }}</span>
            }
          </button>
        } @empty {
          <p class="cv-filterable-picker__empty">{{ emptyMessage() }}</p>
        }
      </div>
    </div>
  `,
})
export class FilterableListPickerComponent {
  readonly inputId = input('');
  readonly ariaLabel = input('Options');
  readonly filterPlaceholder = input('Filter…');
  readonly emptyMessage = input('No matches');
  readonly maxHeight = input('11rem');
  readonly disabled = input(false);
  readonly options = input<FilterableListOption[]>([]);
  readonly value = input<string | null>(null);

  readonly valueChange = output<string>();

  protected filterText = '';

  protected readonly filteredOptions = computed(() => {
    const query = this.filterText.trim().toLowerCase();
    const items = this.options();
    if (!query) return items;
    return items.filter((item) => item.search.toLowerCase().includes(query));
  });

  protected select(next: string): void {
    if (this.disabled() || next === this.value()) return;
    this.valueChange.emit(next);
  }
}
