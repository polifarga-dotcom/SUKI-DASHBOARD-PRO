import { writable } from 'svelte/store';

/** True once the client-side superadmin check has confirmed the current user. */
export const isSuperAdminStore = writable(false);
