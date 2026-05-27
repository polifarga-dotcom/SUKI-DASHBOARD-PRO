import { writable } from 'svelte/store';
import type { Session } from '@supabase/supabase-js';
import type { UserRole } from '$lib/types.js';

type AuthState = {
	session: Session | null;
	roleData: Pick<UserRole, 'role' | 'force_password_change'> | null;
	loading: boolean;
};

function createAuthStore() {
	const { subscribe, set, update } = writable<AuthState>({
		session: null,
		roleData: null,
		loading: true,
	});

	return {
		subscribe,
		setSession: (session: Session | null) =>
			update((s) => ({ ...s, session, loading: false })),
		setRole: (roleData: AuthState['roleData']) =>
			update((s) => ({ ...s, roleData })),
		clearPasswordChange: () =>
			update((s) => ({
				...s,
				roleData: s.roleData ? { ...s.roleData, force_password_change: false } : null,
			})),
		clear: () => set({ session: null, roleData: null, loading: false }),
	};
}

export const authStore = createAuthStore();
