import { writable } from 'svelte/store';

// Captured beforeinstallprompt event — null if not available (iOS, already installed, desktop)
export const pwaInstallPrompt = writable<any>(null);
