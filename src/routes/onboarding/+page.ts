import { redirect } from '@sveltejs/kit';
import { supabase } from '$lib/supabase.js';
import type { PageLoad } from './$types';

// Run client-side only — Cloudflare Worker has no localStorage,
// so the Supabase session would be missing in SSR context.
export const ssr = false;

export const load: PageLoad = async () => {
	const { data: { session } } = await supabase.auth.getSession();
	if (!session) throw redirect(302, '/login');
};
