import type { Session } from '@supabase/supabase-js';

declare global {
	namespace App {
		interface PageData {
			session?: Session | null;
			role?: 'admin' | 'viewer';
		}
	}
}

export {};
