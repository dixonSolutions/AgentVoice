import type { ApplicationConfig } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MessageService } from '@openng/optimus-ui/api';
import { provideOptimus } from '@openng/optimus-ui/config';
import Aura from '@openng/optimus-ui-themes/aura';

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimationsAsync(),
    MessageService,
    provideOptimus({
      theme: {
        preset: Aura,
        options: {
          // Toggled by AppearanceService on <html>
          darkModeSelector: '.app-dark',
          cssLayer: false,
        },
      },
      ripple: true,
    }),
  ],
};
