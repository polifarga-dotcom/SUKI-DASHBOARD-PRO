import { redirect } from '@sveltejs/kit';
import { supabase } from '$lib/supabase.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
	const {
		data: { session }
	} = await supabase.auth.getSession();
	if (session) throw redirect(302, '/vessel');
	return {};
};
